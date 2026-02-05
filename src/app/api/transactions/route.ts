// src/app/api/transactions/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type Facet = { value: string; label: string };

type TxOut = {
  id: string;
  leagueId: string;
  season: number;
  week: number;
  type: string;
  typeLabel: string;
  createdAt: string;
  teams: string[];
  received: { rosterId: number; team: string; items: string[] }[];
  sent: { rosterId: number; team: string; items: string[] }[];
};

type LeagueSeasonRow = {
  leagueId: string;
  season: number;
  previousLeagueId: string | null;
};

function csvToArray(v: string | null) {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

async function getLeagueChainFromDb(rootLeagueId: string) {
  const leagueIds: string[] = [];
  const seasonToLeagueId = new Map<number, string>();

  let cur: string | null = rootLeagueId;
  let guard = 0;

  while (cur && guard++ < 20) {
    leagueIds.push(cur);

    const row: LeagueSeasonRow | null = await db.leagueSeason.findFirst({
      where: { leagueId: cur },
      select: { leagueId: true, season: true, previousLeagueId: true },
    });

    if (row?.season) seasonToLeagueId.set(row.season, row.leagueId);
    cur = row?.previousLeagueId ?? null;
  }

  return { leagueIds, seasonToLeagueId };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const rootLeagueId = url.searchParams.get("leagueId") || process.env.SLEEPER_LEAGUE_ID!;

    const seasonsFilter = csvToArray(url.searchParams.get("season"))
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));

    const typesFilter = csvToArray(url.searchParams.get("type"));

    const teamsFilter = csvToArray(url.searchParams.get("team"))
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));

    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize") ?? "50")));

    const { leagueIds, seasonToLeagueId } = await getLeagueChainFromDb(rootLeagueId);

    // If DB chain table isn't populated, fall back to only root
    const leagues = leagueIds.length ? leagueIds : [rootLeagueId];

    const where: any = {
      leagueId: { in: leagues },
    };

    if (seasonsFilter.length) where.season = { in: seasonsFilter };
    if (typesFilter.length) where.type = { in: typesFilter };

    if (teamsFilter.length) {
      where.assets = {
        some: {
          OR: [{ fromRosterId: { in: teamsFilter } }, { toRosterId: { in: teamsFilter } }],
        },
      };
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

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    // facets (across chain)
    const [seasonRows, typeRows] = await Promise.all([
      db.transaction.findMany({
        where: { leagueId: { in: leagues } },
        distinct: ["season"],
        select: { season: true },
        orderBy: { season: "desc" },
      }),
      db.transaction.findMany({
        where: { leagueId: { in: leagues } },
        distinct: ["type"],
        select: { type: true },
      }),
    ]);

    const facetSeasons: Facet[] = seasonRows.map((s) => ({
      value: String(s.season),
      label: String(s.season),
    }));

    const facetTypes: Facet[] = (typeRows.map((t) => t.type).filter(Boolean) as string[])
      .sort()
      .map((t) => ({ value: t, label: prettyType(t) }));

    // Choose a "teams season" to label owners (use newest season in chain)
    const teamsSeason =
      facetSeasons.length > 0 ? Number(facetSeasons[0].value) : new Date().getFullYear();

    // rosters for that season (for team facet labels)
    const teamRosters = await db.roster.findMany({
      where: { leagueId: rootLeagueId, season: teamsSeason },
      select: { rosterId: true, ownerId: true },
      orderBy: { rosterId: "asc" },
    });

    const ownerIds = uniq(teamRosters.map((r) => r.ownerId).filter((x): x is string => !!x));
    const owners =
      ownerIds.length > 0
        ? await db.sleeperUser.findMany({
            where: { sleeperUserId: { in: ownerIds } },
            select: { sleeperUserId: true, displayName: true, username: true },
          })
        : [];

    const ownerMap = new Map(
      owners.map((o) => [o.sleeperUserId, (o.displayName ?? o.username ?? "").trim()])
    );

    const rosterIdToTeamLabelRootSeason = new Map<number, string>();
    for (const r of teamRosters) {
      const label = (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`;
      rosterIdToTeamLabelRootSeason.set(r.rosterId, label);
    }

    const facetTeams: Facet[] = teamRosters.map((r) => ({
      value: String(r.rosterId),
      label: (rosterIdToTeamLabelRootSeason.get(r.rosterId) || `Roster ${r.rosterId}`)
        .replace(/^Roster\s+\d+\s*[-–:]?\s*/i, "")
        .trim(),
    }));

    // For page rows, we need roster labels per (leagueId, season)
    const leagueSeasonPairs = uniq(rows.map((t) => `${t.leagueId}::${t.season}`)).map((k) => {
      const [lid, s] = k.split("::");
      return { leagueId: lid, season: Number(s) };
    });

    const rosterRows =
      leagueSeasonPairs.length > 0
        ? await db.roster.findMany({
            where: {
              OR: leagueSeasonPairs.map((p) => ({ leagueId: p.leagueId, season: p.season })),
            },
            select: { leagueId: true, season: true, rosterId: true, ownerId: true },
          })
        : [];

    const ownerIdsPage = uniq(rosterRows.map((r) => r.ownerId).filter((x): x is string => !!x));
    const ownersPage =
      ownerIdsPage.length > 0
        ? await db.sleeperUser.findMany({
            where: { sleeperUserId: { in: ownerIdsPage } },
            select: { sleeperUserId: true, displayName: true, username: true },
          })
        : [];

    const ownerMapPage = new Map(
      ownersPage.map((o) => [o.sleeperUserId, (o.displayName ?? o.username ?? "").trim()])
    );

    const rosterLabelMap = new Map<string, string>();
    for (const r of rosterRows) {
      const label = (r.ownerId && ownerMapPage.get(r.ownerId)) || `Roster ${r.rosterId}`;
      rosterLabelMap.set(`${r.leagueId}::${r.season}::${r.rosterId}`, label);
    }

    const rosterLabel = (lid: string, season: number, rosterId: number | null | undefined) => {
      if (rosterId === null || rosterId === undefined) return "—";
      return (
        rosterLabelMap.get(`${lid}::${season}::${rosterId}`) ??
        rosterIdToTeamLabelRootSeason.get(rosterId) ??
        `Roster ${rosterId}`
      );
    };

    // Players for page
    const playerIds = uniq(
      rows.flatMap((t) => t.assets).map((a) => a.playerId).filter((x): x is string => !!x)
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

    const pickLabel = (t: any, a: any) => {
      const ys = typeof a.pickSeason === "number" ? a.pickSeason : null;
      const rd = typeof a.pickRound === "number" ? a.pickRound : null;

      // Use pickSeason to choose the correct leagueId for roster naming, but fall back safely
      const seasonForNames = ys ?? t.season;
      const lidForNames =
        (ys && seasonToLeagueId.get(ys)) ||
        seasonToLeagueId.get(teamsSeason) ||
        t.leagueId;

      // IMPORTANT: fromRosterId is the "original pick owner" in Sleeper trade assets
      const original = typeof a.fromRosterId === "number" ? a.fromRosterId : null;
      const originalTeam =
        original !== null ? rosterLabel(lidForNames, seasonForNames, original) : null;

      const prefix = originalTeam ? `(${originalTeam} pick) ` : "";
      const core = `${ys ?? "?"} R${rd ?? "?"}`;

      return `${prefix}${core}`;
    };

    const assetLabel = (t: any, a: any) => {
      if (a.kind === "pick") return pickLabel(t, a);
      if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
      if (a.playerId) return playerLabel(a.playerId);
      return a.kind ?? "asset";
    };

    const items: TxOut[] = rows.map((t: any) => {
      const involvedRosterIds = uniq(
        t.assets
          .flatMap((a: any) => [a.fromRosterId, a.toRosterId])
          .filter((x: any) => typeof x === "number")
      ) as number[];

      const teams = involvedRosterIds
        .map((rid) => rosterLabel(t.leagueId, t.season, rid))
        .filter((x) => x !== "—");

      const receivedMap = new Map<number, string[]>();
      const sentMap = new Map<number, string[]>();

      for (const a of t.assets) {
        const from = a.fromRosterId;
        const to = a.toRosterId;

        if (t.type === "trade") {
          if (typeof from === "number" && typeof to === "number" && from !== to) {
            const recv = receivedMap.get(to) ?? [];
            recv.push(assetLabel(t, a));
            receivedMap.set(to, recv);

            const sent = sentMap.get(from) ?? [];
            sent.push(assetLabel(t, a));
            sentMap.set(from, sent);
          }
          continue;
        }

        // Non-trades: Added/Dropped semantics
        if (typeof to === "number" && (from === null || from === undefined)) {
          const recv = receivedMap.get(to) ?? [];
          recv.push(assetLabel(t, a));
          receivedMap.set(to, recv);
        }
        if (typeof from === "number" && (to === null || to === undefined)) {
          const sent = sentMap.get(from) ?? [];
          sent.push(assetLabel(t, a));
          sentMap.set(from, sent);
        }
      }

      const received = Array.from(receivedMap.entries()).map(([rid, list]) => ({
        rosterId: rid,
        team: rosterLabel(t.leagueId, t.season, rid),
        items: list,
      }));

      const sent = Array.from(sentMap.entries()).map(([rid, list]) => ({
        rosterId: rid,
        team: rosterLabel(t.leagueId, t.season, rid),
        items: list,
      }));

      received.sort((a, b) => a.rosterId - b.rosterId);
      sent.sort((a, b) => a.rosterId - b.rosterId);

      return {
        id: t.id,
        leagueId: t.leagueId,
        season: t.season,
        week: t.week,
        type: t.type,
        typeLabel: prettyType(t.type),
        createdAt: t.createdAt.toISOString(),
        teams: teams.length ? (teams.length === 2 ? [teams[0], teams[1]] : teams) : [],
        received,
        sent,
      };
    });

    return NextResponse.json({
      ok: true,
      rootLeagueId,
      leagueIds: leagues,
      total,
      page,
      pageSize,
      totalPages,
      items,
      facets: {
        seasons: facetSeasons,
        types: facetTypes,
        teams: facetTeams,
        teamsSeason,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
