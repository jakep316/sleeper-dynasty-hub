import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague } from "@/lib/sleeper";

export const dynamic = "force-dynamic";

const PAGE_SIZE_DEFAULT = 50;

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

async function getLeagueChainIds(startLeagueId: string, max = 20) {
  const ids: string[] = [];
  let cur: string | null = startLeagueId;

  while (cur && ids.length < max) {
    ids.push(cur);
    const l: any = await getLeague(cur);
    cur = l?.previous_league_id ?? null;
  }

  return ids;
}

function parseCsvInts(v: string | null): number[] {
  if (!v) return [];
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

function parseCsvStrings(v: string | null): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function toInt(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);

    const rootLeagueId =
      url.searchParams.get("rootLeagueId") || process.env.SLEEPER_LEAGUE_ID || "";

    if (!rootLeagueId) {
      return NextResponse.json({ ok: false, error: "Missing rootLeagueId / SLEEPER_LEAGUE_ID" }, { status: 400 });
    }

    const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
    const pageSize = Math.max(1, Math.min(200, Number(url.searchParams.get("pageSize") || PAGE_SIZE_DEFAULT)));

    // Multi filters:
    const seasons = parseCsvInts(url.searchParams.get("seasons")); // e.g. "2026,2025"
    const teams = parseCsvInts(url.searchParams.get("teams")); // rosterIds
    const types = parseCsvStrings(url.searchParams.get("types")); // e.g. "trade,free_agent"

    const leagueIds = await getLeagueChainIds(rootLeagueId);

    const where: any = { leagueId: { in: leagueIds } };
    if (seasons.length) where.season = { in: seasons };
    if (types.length) where.type = { in: types };

    if (teams.length) {
      where.assets = { some: { OR: teams.flatMap((rid) => [{ fromRosterId: rid }, { toRosterId: rid }]) } };
    }

    // count + page
    const [totalCount, rows] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.findMany({
        where,
        orderBy: [{ season: "desc" }, { week: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { assets: true },
      }),
    ]);

    // roster labels for the rows we’re returning
    const leagueSeasonPairs = Array.from(new Set(rows.map((t) => `${t.leagueId}::${t.season}`))).map((k) => {
      const [lid, s] = k.split("::");
      return { leagueId: lid, season: Number(s) };
    });

    const rosterRows =
      leagueSeasonPairs.length > 0
        ? await db.roster.findMany({
            where: { OR: leagueSeasonPairs.map((p) => ({ leagueId: p.leagueId, season: p.season })) },
            select: { leagueId: true, season: true, rosterId: true, ownerId: true },
          })
        : [];

    const ownerIds = uniq(rosterRows.map((r) => r.ownerId).filter((x): x is string => !!x));
    const owners =
      ownerIds.length > 0
        ? await db.sleeperUser.findMany({
            where: { sleeperUserId: { in: ownerIds } },
            select: { sleeperUserId: true, displayName: true, username: true },
          })
        : [];

    const ownerMap = new Map(owners.map((o) => [o.sleeperUserId, o.displayName ?? o.username]));
    const rosterLabelMap = new Map<string, string>();
    for (const r of rosterRows) {
      const label = (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`;
      rosterLabelMap.set(`${r.leagueId}::${r.season}::${r.rosterId}`, label);
    }

    const rosterLabel = (lid: string, season: number, rosterId: number | null | undefined) => {
      if (rosterId === null || rosterId === undefined) return "—";
      return rosterLabelMap.get(`${lid}::${season}::${rosterId}`) ?? `Roster ${rosterId}`;
    };

    // players for page
    const playerIds = uniq(
      rows
        .flatMap((t) => t.assets)
        .map((a) => a.playerId)
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    );

    const players =
      playerIds.length > 0
        ? await db.sleeperPlayer.findMany({
            where: { id: { in: playerIds } },
            select: { id: true, fullName: true, position: true, team: true },
          })
        : [];

    const playerMap = new Map(players.map((p) => [p.id, p]));
    const playerLabel = (id: string) => {
      const p = playerMap.get(id);
      if (!p) return `Player ${id}`;
      const name = p.fullName ?? `Player ${id}`;
      const parts = [p.position, p.team].filter(Boolean);
      return parts.length ? `${name} (${parts.join(", ")})` : name;
    };

    function pickLabel(t: any, a: any) {
      const ys = typeof a.pickSeason === "number" ? a.pickSeason : null;
      const rd = typeof a.pickRound === "number" ? a.pickRound : null;
      if (!ys || !rd) return "Pick";

      const raw = t.rawJson as any;
      const dp = Array.isArray(raw?.draft_picks) ? raw.draft_picks : [];

      const toRid = typeof a.toRosterId === "number" ? a.toRosterId : null;
      const fromRid = typeof a.fromRosterId === "number" ? a.fromRosterId : null;

      let match =
        dp.find((p: any) => {
          const season = toInt(p?.season);
          const round = toInt(p?.round);
          const owner = toInt(p?.owner_id);
          const prev = toInt(p?.previous_owner_id);
          return (
            season === ys &&
            round === rd &&
            (toRid === null || owner === toRid) &&
            (fromRid === null || prev === fromRid)
          );
        }) ?? null;

      if (!match && toRid !== null) {
        match =
          dp.find((p: any) => {
            const season = toInt(p?.season);
            const round = toInt(p?.round);
            const owner = toInt(p?.owner_id);
            return season === ys && round === rd && owner === toRid;
          }) ?? null;
      }

      const original = toInt(match?.original_owner_id) ?? null;
      const label = original ? rosterLabel(t.leagueId, t.season, original) : null;

      return label ? `${ys} R${rd} (${label} pick)` : `${ys} R${rd}`;
    }

    const assetLabel = (t: any, a: any) => {
      if (a.kind === "pick") return pickLabel(t, a);
      if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
      if (a.playerId) return playerLabel(a.playerId);
      return a.kind ?? "asset";
    };

    // Compute display fields server-side so client is simple
    const items = rows.map((t: any) => {
      const dateStr = new Date(t.createdAt).toISOString();

      // Teams label
      let teamsLabel = "—";
      if (t.type === "trade") {
        const involved: number[] = [];
        for (const a of t.assets) {
          if (typeof a.fromRosterId === "number") involved.push(a.fromRosterId);
          if (typeof a.toRosterId === "number") involved.push(a.toRosterId);
        }
        const clean = uniq(involved)
          .map((rid) => rosterLabel(t.leagueId, t.season, rid))
          .filter((x) => x !== "—");

        teamsLabel =
          clean.length === 2 ? `${clean[0]} ↔ ${clean[1]}` : clean.length ? clean.join(" ↔ ") : "—";
      } else {
        const involved: number[] = [];
        for (const a of t.assets) {
          if (typeof a.fromRosterId === "number") involved.push(a.fromRosterId);
          if (typeof a.toRosterId === "number") involved.push(a.toRosterId);
        }
        const clean = uniq(involved)
          .map((rid) => rosterLabel(t.leagueId, t.season, rid))
          .filter((x) => x !== "—");
        teamsLabel = clean.length ? clean.join(", ") : "—";
      }

      // Moves
      if (t.type === "trade") {
        const received = new Map<number, string[]>();
        const sent = new Map<number, string[]>();
        const involved = new Set<number>();

        for (const a of t.assets) {
          const from = typeof a.fromRosterId === "number" ? a.fromRosterId : null;
          const to = typeof a.toRosterId === "number" ? a.toRosterId : null;
          const label = assetLabel(t, a);

          if (from !== null) {
            involved.add(from);
            sent.set(from, [...(sent.get(from) ?? []), label]);
          }
          if (to !== null) {
            involved.add(to);
            received.set(to, [...(received.get(to) ?? []), label]);
          }
        }

        const teamIds = Array.from(involved).sort((a, b) => a - b);

        const tradeLines = teamIds.map((rid) => ({
          rosterId: rid,
          team: rosterLabel(t.leagueId, t.season, rid),
          received: received.get(rid) ?? [],
          sent: sent.get(rid) ?? [],
        }));

        return {
          id: t.id,
          leagueId: t.leagueId,
          season: t.season,
          week: t.week,
          type: t.type,
          typeLabel: prettyType(t.type),
          date: dateStr,
          teamsLabel,
          moves: { kind: "trade" as const, lines: tradeLines },
        };
      }

      const adds: string[] = [];
      const drops: string[] = [];

      for (const a of t.assets) {
        if (!a.playerId) continue;
        const label = playerLabel(a.playerId);
        if (a.fromRosterId && !a.toRosterId) drops.push(label);
        if (!a.fromRosterId && a.toRosterId) adds.push(label);
      }

      return {
        id: t.id,
        leagueId: t.leagueId,
        season: t.season,
        week: t.week,
        type: t.type,
        typeLabel: prettyType(t.type),
        date: dateStr,
        teamsLabel,
        moves: { kind: "simple" as const, adds, drops },
      };
    });

    return NextResponse.json({
      ok: true,
      rootLeagueId,
      chainLeagueIds: leagueIds,
      page,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
      items,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
