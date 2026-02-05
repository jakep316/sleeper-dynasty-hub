import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague } from "@/lib/sleeper";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_CHAIN = 20;

function toInt(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parseCsvNumbers(v: string | null): number[] {
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

/**
 * Walk the Sleeper previous_league_id chain.
 * Returns [current, previous, ...]
 */
async function getLeagueChainIds(startLeagueId: string) {
  const ids: string[] = [];
  const seen = new Set<string>();

  let current: string | null = startLeagueId;

  for (let i = 0; i < MAX_CHAIN && current; i++) {
    if (seen.has(current)) break;
    seen.add(current);
    ids.push(current);

    const l: any = await getLeague(current);
    current = l?.previous_league_id ?? null;
  }

  return ids;
}

/**
 * Build rosterLabel lookup:
 * key: `${leagueId}::${season}::${rosterId}` -> label
 * plus season -> leagueId map for correct pick-season labeling.
 */
async function buildRosterLabelMap(leagueIds: string[]) {
  const seasonToLeagueId = new Map<number, string>();
  const leagueSeasonPairs: Array<{ leagueId: string; season: number }> = [];

  for (const lid of leagueIds) {
    const l: any = await getLeague(lid);
    const s = Number(l?.season);
    if (Number.isFinite(s)) {
      seasonToLeagueId.set(s, lid);
      leagueSeasonPairs.push({ leagueId: lid, season: s });
    }
  }

  const rosterRows =
    leagueSeasonPairs.length > 0
      ? await db.roster.findMany({
          where: {
            OR: leagueSeasonPairs.map((p) => ({ leagueId: p.leagueId, season: p.season })),
          },
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

  const ownerMap = new Map(
    owners.map((o) => [
      o.sleeperUserId,
      o.displayName ?? o.username ?? o.sleeperUserId,
    ])
  );

  const rosterLabelMap = new Map<string, string>();
  for (const r of rosterRows) {
    const label = (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`;
    rosterLabelMap.set(`${r.leagueId}::${r.season}::${r.rosterId}`, label);
  }

  function rosterLabel(leagueId: string, season: number, rosterId: number | null | undefined) {
    if (rosterId === null || rosterId === undefined) return "—";
    return rosterLabelMap.get(`${leagueId}::${season}::${rosterId}`) ?? `Roster ${rosterId}`;
  }

  return { rosterLabel, seasonToLeagueId };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const rootLeagueId = searchParams.get("rootLeagueId") || process.env.SLEEPER_LEAGUE_ID;
    if (!rootLeagueId) {
      return NextResponse.json(
        { ok: false, error: "Missing rootLeagueId (or SLEEPER_LEAGUE_ID env)." },
        { status: 400 }
      );
    }

    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const pageSizeRaw = Number(searchParams.get("pageSize") ?? DEFAULT_PAGE_SIZE);
    const pageSize = Math.max(
      1,
      Math.min(DEFAULT_PAGE_SIZE, Number.isFinite(pageSizeRaw) ? pageSizeRaw : DEFAULT_PAGE_SIZE)
    );

    const seasons = parseCsvNumbers(searchParams.get("seasons"));
    const types = parseCsvStrings(searchParams.get("types"));
    const teams = parseCsvNumbers(searchParams.get("teams")); // rosterIds

    // 1) League chain
    const chainLeagueIds = await getLeagueChainIds(rootLeagueId);

    // 2) Roster labels + season->leagueId map for pick labels
    const { rosterLabel, seasonToLeagueId } = await buildRosterLabelMap(chainLeagueIds);

    // 3) Prisma where
    const where: any = {
      leagueId: { in: chainLeagueIds },
    };

    if (seasons.length) where.season = { in: seasons };
    if (types.length) where.type = { in: types };

    if (teams.length) {
      where.assets = {
        some: {
          OR: [{ fromRosterId: { in: teams } }, { toRosterId: { in: teams } }],
        },
      };
    }

    // 4) Count + page of txs
    const [totalCount, txs] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.findMany({
        where,
        orderBy: [{ season: "desc" }, { week: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { assets: true },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    // 5) Player map for this page
    const playerIds = uniq(
      txs
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

    // Helper: find FAAB spent for a tx (waiver/FA)
    function getFaabSpent(t: any): number | null {
      // Prefer stored faab asset
      const faabAsset = (t.assets as any[]).find((a) => a.kind === "faab" && typeof a.faabAmount === "number");
      if (faabAsset && typeof faabAsset.faabAmount === "number") return faabAsset.faabAmount;

      // Fallback to rawJson.settings.waiver_bid (Sleeper)
      const raw = t.rawJson as any;
      const bid = toInt(raw?.settings?.waiver_bid);
      return bid !== null ? bid : null;
    }

    // 6) Draft pick label with ORIGINAL OWNER (defensive)
    function pickLabel(t: any, a: any) {
      const ys = typeof a.pickSeason === "number" ? a.pickSeason : null;
      const rd = typeof a.pickRound === "number" ? a.pickRound : null;
      if (!ys || !rd) return "Pick";

      const raw = t.rawJson as any;
      const dp = Array.isArray(raw?.draft_picks) ? raw.draft_picks : [];

      const toRid = typeof a.toRosterId === "number" ? a.toRosterId : null;
      const fromRid = typeof a.fromRosterId === "number" ? a.fromRosterId : null;

      // Find best matching draft pick object from Sleeper rawJson
      let match: any =
        dp.find((p: any) => {
          const season = toInt(p?.season);
          const round = toInt(p?.round);
          const owner = toInt(p?.owner_id);
          const prev = toInt(p?.previous_owner_id);
          const rosterId = toInt(p?.roster_id);
          return (
            season === ys &&
            round === rd &&
            // Owner should usually be "to" roster after the trade
            (toRid === null || owner === toRid || rosterId === toRid) &&
            // Previous owner should usually be "from" roster
            (fromRid === null || prev === fromRid)
          );
        }) ?? null;

      // Fallback: match by season+round only (some payloads omit prev/owner fields)
      if (!match) {
        match =
          dp.find((p: any) => {
            const season = toInt(p?.season);
            const round = toInt(p?.round);
            return season === ys && round === rd;
          }) ?? null;
      }

      // Extract original owner roster id from any known field
      const original =
        toInt(match?.original_owner_id) ??
        toInt(match?.original_roster_id) ??
        toInt(match?.roster_id) ??
        null;

      // IMPORTANT: label in the leagueId for THAT season (not the current season’s league)
      const pickLeagueId = seasonToLeagueId.get(ys) ?? t.leagueId;

      const label = original ? rosterLabel(pickLeagueId, ys, original) : null;

      return label ? `${ys} R${rd} (${label} pick)` : `${ys} R${rd}`;
    }

    const assetLabel = (t: any, a: any) => {
      if (a.kind === "pick") return pickLabel(t, a);
      if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
      if (a.playerId) return playerLabel(a.playerId);
      return a.kind ?? "asset";
    };

    function teamsLabel(t: any) {
      if (t.type === "trade") {
        const involved: number[] = [];
        for (const a of t.assets as any[]) {
          if (typeof a.fromRosterId === "number") involved.push(a.fromRosterId);
          if (typeof a.toRosterId === "number") involved.push(a.toRosterId);
        }
        const clean = uniq(involved)
          .map((rid) => rosterLabel(t.leagueId, t.season, rid))
          .filter((x) => x !== "—");

        if (clean.length === 2) return `${clean[0]} ↔ ${clean[1]}`;
        if (clean.length > 2) return clean.join(" ↔ ");
        return clean[0] ?? "—";
      }

      const rids = uniq(
        (t.assets as any[])
          .flatMap((a: any) => [a.fromRosterId, a.toRosterId])
          .filter((x: any) => typeof x === "number")
      ) as number[];

      const labels = rids.map((rid) => rosterLabel(t.leagueId, t.season, rid)).filter((x) => x !== "—");
      return labels.length ? labels.join(", ") : "—";
    }

    // 7) Build response items
    const items = txs.map((t) => {
      if (t.type === "trade") {
        const received = new Map<number, string[]>();
        const sent = new Map<number, string[]>();

        for (const a of t.assets as any[]) {
          const from = a.fromRosterId;
          const to = a.toRosterId;

          if (typeof from === "number" && typeof to === "number" && from !== to) {
            const label = assetLabel(t, a);

            const r = received.get(to) ?? [];
            r.push(label);
            received.set(to, r);

            const s = sent.get(from) ?? [];
            s.push(label);
            sent.set(from, s);
          }
        }

        const teamIds = uniq([...Array.from(received.keys()), ...Array.from(sent.keys())]).sort((a, b) => a - b);

        const lines = teamIds.map((rid) => ({
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
          date: t.createdAt.toISOString(),
          teamsLabel: teamsLabel(t),
          moves: { kind: "trade" as const, lines },
        };
      }

      // Non-trades: Added/Dropped + FAAB spent for waivers
      const adds: string[] = [];
      const drops: string[] = [];

      const faabSpent = t.type === "waiver" ? getFaabSpent(t) : null;

      for (const a of t.assets as any[]) {
        // players
        if (a.playerId) {
          const labelBase = playerLabel(a.playerId);

          // Added: attach FAAB if this is a waiver add and we have a bid
          const label =
            faabSpent && !a.fromRosterId && a.toRosterId ? `${labelBase} (FAAB $${faabSpent})` : labelBase;

          if (a.fromRosterId && !a.toRosterId) drops.push(labelBase);
          if (!a.fromRosterId && a.toRosterId) adds.push(label);
          continue;
        }

        // Picks / FAAB for non-trades (optional)
        if (a.kind === "pick") {
          const label = assetLabel(t, a);
          if (a.fromRosterId && !a.toRosterId) drops.push(label);
          if (!a.fromRosterId && a.toRosterId) adds.push(label);
        }
      }

      return {
        id: t.id,
        leagueId: t.leagueId,
        season: t.season,
        week: t.week,
        type: t.type,
        typeLabel: prettyType(t.type),
        date: t.createdAt.toISOString(),
        teamsLabel: teamsLabel(t),
        moves: { kind: "simple" as const, adds, drops },
      };
    });

    return NextResponse.json({
      ok: true,
      rootLeagueId,
      chainLeagueIds,
      page,
      pageSize,
      totalCount,
      totalPages,
      items,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
