import { NextResponse } from "next/server";
import { db } from "@/lib/db";

function parseCsv(param: string | null): string[] {
  if (!param) return [];
  return param
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * League chain list based on LeagueSeason table (what you already sync).
 * Includes root itself and walks previousLeagueId backward.
 */
async function getLeagueIdsForRoot(rootLeagueId: string): Promise<string[]> {
  const allSeasonRows = await db.leagueSeason.findMany({
    select: { leagueId: true, previousLeagueId: true, season: true },
  });

  const prevMap = new Map<string, string | null>();
  for (const r of allSeasonRows) prevMap.set(r.leagueId, r.previousLeagueId ?? null);

  const chain: string[] = [];
  let cur: string | null = rootLeagueId;

  while (cur) {
    chain.push(cur);
    cur = prevMap.get(cur) ?? null;
    if (chain.length > 40) break; // safety
  }

  return uniq(chain);
}

async function buildRosterLabelMap(leagueSeasonPairs: { leagueId: string; season: number }[]) {
  if (leagueSeasonPairs.length === 0) return new Map<string, string>();

  const rosterRows = await db.roster.findMany({
    where: { OR: leagueSeasonPairs.map((p) => ({ leagueId: p.leagueId, season: p.season })) },
    select: { leagueId: true, season: true, rosterId: true, ownerId: true },
  });

  const ownerIds = uniq(rosterRows.map((r) => r.ownerId).filter((x): x is string => !!x));
  const owners =
    ownerIds.length > 0
      ? await db.sleeperUser.findMany({
          where: { sleeperUserId: { in: ownerIds } },
          select: { sleeperUserId: true, displayName: true, username: true },
        })
      : [];

  const ownerMap = new Map<string, string>();
  for (const o of owners) {
    ownerMap.set(o.sleeperUserId, o.displayName ?? o.username ?? o.sleeperUserId);
  }

  const rosterLabelMap = new Map<string, string>();
  for (const r of rosterRows) {
    const label = (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`;
    rosterLabelMap.set(`${r.leagueId}::${r.season}::${r.rosterId}`, label);
  }

  return rosterLabelMap;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const rootLeagueId = url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID ?? "";
    if (!rootLeagueId) return NextResponse.json({ ok: false, error: "Missing leagueId" }, { status: 400 });

    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") ?? "50")));

    // Multi-select filters (CSV)
    const seasonsCsv = parseCsv(url.searchParams.get("seasons")); // "2026,2025"
    const typesCsv = parseCsv(url.searchParams.get("types")); // "trade,free_agent"
    const teamsCsv = parseCsv(url.searchParams.get("teams")); // rosterIds "1,2"
    const playerId = (url.searchParams.get("playerId") ?? "").trim() || null;

    const leagueIds = await getLeagueIdsForRoot(rootLeagueId);

    // ---- FACETS (across full league chain) ----
    const [seasonRows, typeRows] = await Promise.all([
      db.transaction.findMany({
        where: { leagueId: { in: leagueIds } },
        distinct: ["season"],
        select: { season: true },
        orderBy: { season: "desc" },
      }),
      db.transaction.findMany({
        where: { leagueId: { in: leagueIds } },
        distinct: ["type"],
        select: { type: true },
      }),
    ]);

    const facetSeasons = seasonRows.map((r) => r.season).filter((x): x is number => typeof x === "number");
    const facetTypes = (typeRows.map((r) => r.type).filter(Boolean) as string[]).sort();

    // For team(owner) filter, pick a "season context":
    // - If user selected exactly 1 season, use it
    // - Else use latest season found in facets
    const selectedSeasons = seasonsCsv.map((s) => Number(s)).filter((n) => Number.isFinite(n));
    const seasonForTeams =
      selectedSeasons.length === 1 ? selectedSeasons[0] : facetSeasons[0] ?? new Date().getFullYear();

    // Map season -> leagueId (from LeagueSeason rows, limited to chain)
    const leagueSeasonRows = await db.leagueSeason.findMany({
      where: { leagueId: { in: leagueIds } },
      select: { leagueId: true, season: true },
    });
    const seasonToLeagueId = new Map<number, string>();
    for (const r of leagueSeasonRows) {
      // in case of duplicates, first is fine
      if (!seasonToLeagueId.has(r.season)) seasonToLeagueId.set(r.season, r.leagueId);
    }
    const leagueIdForTeams = seasonToLeagueId.get(seasonForTeams) ?? rootLeagueId;

    // roster labels for dropdown (owner names)
    const rosterRowsForTeams = await db.roster.findMany({
      where: { leagueId: leagueIdForTeams, season: seasonForTeams },
      select: { rosterId: true, ownerId: true },
      orderBy: { rosterId: "asc" },
    });

    const ownerIds = uniq(rosterRowsForTeams.map((r) => r.ownerId).filter((x): x is string => !!x));
    const owners =
      ownerIds.length > 0
        ? await db.sleeperUser.findMany({
            where: { sleeperUserId: { in: ownerIds } },
            select: { sleeperUserId: true, displayName: true, username: true },
          })
        : [];
    const ownerMap = new Map(owners.map((o) => [o.sleeperUserId, o.displayName ?? o.username ?? o.sleeperUserId]));

    const facetTeams = rosterRowsForTeams.map((r) => ({
      value: String(r.rosterId),
      label: (r.ownerId && ownerMap.get(r.ownerId)) ? String(ownerMap.get(r.ownerId)) : `Roster ${r.rosterId}`,
    }));

    // ---- WHERE ----
    const where: any = { leagueId: { in: leagueIds } };

    if (selectedSeasons.length > 0) where.season = { in: selectedSeasons };
    if (typesCsv.length > 0) where.type = { in: typesCsv };
    if (playerId) where.assets = { some: { playerId } };

    const teamIds = teamsCsv.map((t) => Number(t)).filter((n) => Number.isFinite(n));
    if (teamIds.length > 0) {
      where.assets = {
        some: {
          OR: [{ fromRosterId: { in: teamIds } }, { toRosterId: { in: teamIds } }],
        },
      };
      // If playerId ALSO set, combine with AND (both conditions)
      if (playerId) {
        where.AND = [
          { assets: { some: { playerId } } },
          { assets: { some: { OR: [{ fromRosterId: { in: teamIds } }, { toRosterId: { in: teamIds } }] } } },
        ];
        delete where.assets;
      }
    }

    // ---- QUERY ----
    const [total, rows] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.findMany({
        where,
        orderBy: [{ season: "desc" }, { week: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { assets: true },
      }),
    ]);

    // roster labels for page rows
    const leagueSeasonPairs = uniq(rows.map((t) => `${t.leagueId}::${t.season}`)).map((k) => {
      const [leagueId, seasonStr] = k.split("::");
      return { leagueId, season: Number(seasonStr) };
    });
    const rosterLabelMap = await buildRosterLabelMap(leagueSeasonPairs);

    const rosterLabel = (leagueId: string, season: number, rosterId: number | null | undefined) => {
      if (rosterId === null || rosterId === undefined) return "—";
      return rosterLabelMap.get(`${leagueId}::${season}::${rosterId}`) ?? `Roster ${rosterId}`;
    };

    // player labels
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
            select: { id: true, fullName: true, position: true, team: true, status: true },
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

    const pickLabel = (a: any) => {
      const ys = typeof a.pickSeason === "number" ? String(a.pickSeason) : "?";
      const rd = typeof a.pickRound === "number" ? String(a.pickRound) : "?";
      return `${ys} R${rd}`;
    };

    const assetLabel = (a: any) => {
      if (a.kind === "pick") return pickLabel(a);
      if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
      if (a.playerId) return playerLabel(a.playerId);
      return a.kind ?? "asset";
    };

    const items = rows.map((t) => {
      const teamsInvolved = uniq(
        t.assets.flatMap((a) => [a.fromRosterId, a.toRosterId]).filter((x): x is number => typeof x === "number")
      ).map((rid) => rosterLabel(t.leagueId, t.season, rid));

      const received = new Map<number, string[]>();
      const sent = new Map<number, string[]>();

      for (const a of t.assets) {
        const from = a.fromRosterId;
        const to = a.toRosterId;

        // roster-to-roster movement (trade)
        if (typeof from === "number" && typeof to === "number" && from !== to) {
          const r = received.get(to) ?? [];
          r.push(assetLabel(a));
          received.set(to, r);

          const s = sent.get(from) ?? [];
          s.push(assetLabel(a));
          sent.set(from, s);
        }

        // add/drop + faab for non-trades
        if (t.type !== "trade") {
          if (typeof from === "number" && (to === null || to === undefined) && a.playerId) {
            const s = sent.get(from) ?? [];
            s.push(playerLabel(a.playerId));
            sent.set(from, s);
          }
          if (typeof to === "number" && (from === null || from === undefined) && a.playerId) {
            const r = received.get(to) ?? [];
            r.push(playerLabel(a.playerId));
            received.set(to, r);
          }
          if (a.kind === "faab" && typeof to === "number") {
            const r = received.get(to) ?? [];
            r.push(`FAAB $${a.faabAmount ?? 0}`);
            received.set(to, r);
          }
        }
      }

      return {
        id: t.id,
        leagueId: t.leagueId,
        season: t.season,
        week: t.week,
        type: t.type,
        typeLabel: prettyType(t.type),
        createdAt: t.createdAt.toISOString(),
        teams: teamsInvolved,
        received: Array.from(received.entries()).map(([rid, arr]) => ({
          rosterId: rid,
          team: rosterLabel(t.leagueId, t.season, rid),
          items: arr,
        })),
        sent: Array.from(sent.entries()).map(([rid, arr]) => ({
          rosterId: rid,
          team: rosterLabel(t.leagueId, t.season, rid),
          items: arr,
        })),
      };
    });

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return NextResponse.json({
      ok: true,
      rootLeagueId,
      leagueIds,
      total,
      page,
      pageSize,
      totalPages,
      items,
      facets: {
        seasons: facetSeasons.map((s) => ({ value: String(s), label: String(s) })),
        types: facetTypes.map((t) => ({ value: t, label: prettyType(t) })),
        teams: facetTeams, // rosterId -> owner label (for the chosen season context)
        teamsSeason: seasonForTeams,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
