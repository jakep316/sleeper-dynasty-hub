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

/**
 * Returns the leagueIds we should include for a "root" league:
 * - Uses LeagueSeason rows to include the chain (all seasons you’ve synced)
 * - Always includes the root leagueId itself
 */
async function getLeagueIdsForRoot(rootLeagueId: string): Promise<string[]> {
  const rows = await db.leagueSeason.findMany({
    where: { OR: [{ leagueId: rootLeagueId }, { previousLeagueId: rootLeagueId }] },
    select: { leagueId: true, previousLeagueId: true, season: true },
  });

  // If you’ve been syncing properly, LeagueSeason will contain all seasons & their leagueIds.
  // However, to be safe: also include *all* leagueIds that exist in the Transaction table
  // for seasons that share the same lineage in LeagueSeason.
  const allSeasonRows = await db.leagueSeason.findMany({
    select: { leagueId: true, previousLeagueId: true, season: true },
  });

  // Build a quick adjacency map by following "previousLeagueId".
  const prevMap = new Map<string, string | null>();
  for (const r of allSeasonRows) prevMap.set(r.leagueId, r.previousLeagueId ?? null);

  const chain: string[] = [];
  let cur: string | null = rootLeagueId;

  // Follow backwards: leagueId -> previousLeagueId -> ...
  while (cur) {
    chain.push(cur);
    cur = prevMap.get(cur) ?? null;
    if (chain.length > 30) break; // safety
  }

  return uniq(chain);
}

/**
 * Build roster label map for many (leagueId, season) pairs.
 */
async function buildRosterLabelMap(leagueSeasonPairs: { leagueId: string; season: number }[]) {
  if (leagueSeasonPairs.length === 0) return new Map<string, string>();

  const rosterRows = await db.roster.findMany({
    where: {
      OR: leagueSeasonPairs.map((p) => ({ leagueId: p.leagueId, season: p.season })),
    },
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
  for (const o of owners) ownerMap.set(o.sleeperUserId, o.displayName ?? o.username ?? o.sleeperUserId);

  const rosterLabelMap = new Map<string, string>();
  for (const r of rosterRows) {
    const label = (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`;
    rosterLabelMap.set(`${r.leagueId}::${r.season}::${r.rosterId}`, label);
  }

  return rosterLabelMap;
}

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const rootLeagueId = url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID ?? "";
    if (!rootLeagueId) {
      return NextResponse.json({ ok: false, error: "Missing leagueId" }, { status: 400 });
    }

    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") ?? "50")));

    // Multi-select filters (CSV):
    const seasons = parseCsv(url.searchParams.get("seasons")); // e.g. "2026,2025"
    const types = parseCsv(url.searchParams.get("types")); // e.g. "trade,free_agent"
    const teams = parseCsv(url.searchParams.get("teams")); // rosterIds as strings e.g. "1,2,7"
    const playerId = url.searchParams.get("playerId"); // single player filter

    const leagueIds = await getLeagueIdsForRoot(rootLeagueId);

    // Base where
    const where: any = {
      leagueId: { in: leagueIds },
    };

    if (seasons.length > 0) where.season = { in: seasons.map((s) => Number(s)).filter((n) => Number.isFinite(n)) };
    if (types.length > 0) where.type = { in: types };
    if (playerId) where.assets = { some: { playerId } };

    if (teams.length > 0) {
      const teamIds = teams.map((t) => Number(t)).filter((n) => Number.isFinite(n));
      if (teamIds.length > 0) {
        where.assets = {
          some: {
            OR: [
              { fromRosterId: { in: teamIds } },
              { toRosterId: { in: teamIds } },
            ],
          },
        };
      }
    }

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

    // Build roster label map for anything we’re returning
    const leagueSeasonPairs = uniq(rows.map((t) => `${t.leagueId}::${t.season}`)).map((k) => {
      const [leagueId, seasonStr] = k.split("::");
      return { leagueId, season: Number(seasonStr) };
    });
    const rosterLabelMap = await buildRosterLabelMap(leagueSeasonPairs);

    const rosterLabel = (leagueId: string, season: number, rosterId: number | null | undefined) => {
      if (rosterId === null || rosterId === undefined) return "—";
      return rosterLabelMap.get(`${leagueId}::${season}::${rosterId}`) ?? `Roster ${rosterId}`;
    };

    // Player map for page
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
      // NOTE: “original pick owner” requires storing roster_id from Sleeper draft_picks.
      // If/when you add pickOriginalRosterId to TransactionAsset, you can include it here.
      return `${ys} R${rd}`;
    };

    const assetLabel = (a: any) => {
      if (a.kind === "pick") return pickLabel(a);
      if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
      if (a.playerId) return playerLabel(a.playerId);
      return a.kind ?? "asset";
    };

    // Normalize each transaction into a UI-friendly shape
    const items = rows.map((t) => {
      const teamsInvolved = uniq(
        t.assets
          .flatMap((a) => [a.fromRosterId, a.toRosterId])
          .filter((x): x is number => typeof x === "number")
      ).map((rid) => rosterLabel(t.leagueId, t.season, rid));

      // Compute trade “received/sent” maps (more complete than “added/dropped” for trades)
      const received = new Map<number, string[]>();
      const sent = new Map<number, string[]>();

      for (const a of t.assets) {
        const from = a.fromRosterId;
        const to = a.toRosterId;

        // Roster-to-roster movement
        if (typeof from === "number" && typeof to === "number" && from !== to) {
          const r = received.get(to) ?? [];
          r.push(assetLabel(a));
          received.set(to, r);

          const s = sent.get(from) ?? [];
          s.push(assetLabel(a));
          sent.set(from, s);
        }

        // Waiver/FA drops/adds:
        if (t.type !== "trade") {
          // Drop: fromRosterId set, toRosterId null
          if (typeof from === "number" && (to === null || to === undefined) && a.playerId) {
            const s = sent.get(from) ?? [];
            s.push(playerLabel(a.playerId));
            sent.set(from, s);
          }
          // Add: toRosterId set, fromRosterId null
          if (typeof to === "number" && (from === null || from === undefined) && a.playerId) {
            const r = received.get(to) ?? [];
            r.push(playerLabel(a.playerId));
            received.set(to, r);
          }
          // FAAB line item (if present)
          if (a.kind === "faab" && typeof to === "number") {
            const r = received.get(to) ?? [];
            r.push(`FAAB $${a.faabAmount ?? 0}`);
            received.set(to, r);
          }
        }
      }

      const receivedList = Array.from(received.entries()).map(([rid, arr]) => ({
        rosterId: rid,
        team: rosterLabel(t.leagueId, t.season, rid),
        items: arr,
      }));

      const sentList = Array.from(sent.entries()).map(([rid, arr]) => ({
        rosterId: rid,
        team: rosterLabel(t.leagueId, t.season, rid),
        items: arr,
      }));

      return {
        id: t.id,
        leagueId: t.leagueId,
        season: t.season,
        week: t.week,
        type: t.type,
        typeLabel: prettyType(t.type),
        createdAt: t.createdAt.toISOString(),
        teams: teamsInvolved,
        received: receivedList,
        sent: sentList,
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
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
