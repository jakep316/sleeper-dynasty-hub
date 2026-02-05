// src/app/api/transactions/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague } from "@/lib/sleeper";

type Facet = { value: string; label: string };
type LeagueSeasonRow = { leagueId: string; season: number; previousLeagueId: string | null };

type TxItem = {
  id: string;
  leagueId: string;
  season: number;
  type: string;
  typeLabel: string;
  createdAt: string;

  teams: string[];

  // Trades
  received: { rosterId: number; team: string; items: string[] }[];
  sent: { rosterId: number; team: string; items: string[] }[];

  // Non-trades
  added?: { rosterId: number; team: string; items: string[]; faab?: number }[];
  dropped?: { rosterId: number; team: string; items: string[] }[];
};

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

function csvToArray(v: string | null) {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * IMPORTANT FIX:
 * Even if LeagueSeason exists, it might have previousLeagueId null/incorrect.
 * We always consult Sleeper if the chain would otherwise stop.
 * Also we upsert/fix LeagueSeason rows while walking.
 */
async function getLeagueChain(rootLeagueId: string) {
  const leagueIds: string[] = [];
  const seasonToLeagueId = new Map<number, string>();

  let cur: string | null = rootLeagueId;
  let guard = 0;

  while (cur && guard++ < 20) {
    leagueIds.push(cur);

    // 1) Try DB row
    let row: LeagueSeasonRow | null = await db.leagueSeason.findFirst({
      where: { leagueId: cur },
      select: { leagueId: true, season: true, previousLeagueId: true },
    });

    // 2) Always fetch from Sleeper if:
    //    - row missing OR
    //    - row exists but previousLeagueId is null (chain would stop) OR
    //    - row exists but season is not finite
    const needsSleeper =
      !row || row.previousLeagueId === null || !Number.isFinite(Number(row.season));

    if (needsSleeper) {
      const l = await getLeague(cur); // source of truth
      const season = Number((l as any)?.season);
      const prev = ((l as any)?.previous_league_id ?? null) as string | null;

      if (Number.isFinite(season)) {
        await db.leagueSeason.upsert({
          where: { leagueId_season: { leagueId: cur, season } },
          update: { previousLeagueId: prev },
          create: { leagueId: cur, season, previousLeagueId: prev },
        });
        row = { leagueId: cur, season, previousLeagueId: prev };
      } else {
        // If Sleeper didn't give a season (unlikely), still continue chain using prev.
        row = { leagueId: cur, season: NaN as any, previousLeagueId: prev };
      }
    }

    if (Number.isFinite(Number(row.season))) {
      seasonToLeagueId.set(Number(row.season), row.leagueId);
    }

    cur = row.previousLeagueId ?? null;
  }

  return { leagueIds, seasonToLeagueId };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const rootLeagueId = url.searchParams.get("leagueId") || process.env.SLEEPER_LEAGUE_ID!;
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize") ?? "50")));

    const seasonsFilter = csvToArray(url.searchParams.get("season"))
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));

    const typesFilter = csvToArray(url.searchParams.get("type"));

    const teamsFilter = csvToArray(url.searchParams.get("team"))
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));

    const { leagueIds, seasonToLeagueId } = await getLeagueChain(rootLeagueId);
    const leagues = leagueIds.length ? leagueIds : [rootLeagueId];

    const where: any = { leagueId: { in: leagues } };
    if (seasonsFilter.length) where.season = { in: seasonsFilter };
    if (typesFilter.length) where.type = { in: typesFilter };
    if (teamsFilter.length) {
      where.assets = {
        some: { OR: [{ fromRosterId: { in: teamsFilter } }, { toRosterId: { in: teamsFilter } }] },
      };
    }

    // Facets across ALL leagues in chain
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

    const teamsSeason =
      facetSeasons.length > 0 ? Number(facetSeasons[0].value) : new Date().getFullYear();

    // Team facet labels (newest season in root league)
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

    const rosterIdToRootLabel = new Map<number, string>();
    for (const r of teamRosters) {
      const label = (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`;
      rosterIdToRootLabel.set(r.rosterId, label);
    }

    const facetTeams: Facet[] = teamRosters.map((r) => ({
      value: String(r.rosterId),
      // you said no roster numbers in the filter label
      label: (rosterIdToRootLabel.get(r.rosterId) || `Roster ${r.rosterId}`).trim(),
    }));

    const [total, rows] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.findMany({
        where,
        orderBy: [{ season: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          leagueId: true,
          season: true,
          type: true,
          createdAt: true,
          rawJson: true,
          assets: true,
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    // Roster labels for any (leagueId, season) in page
    const leagueSeasonPairs = uniq(rows.map((t) => `${t.leagueId}::${t.season}`)).map((k) => {
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
        rosterIdToRootLabel.get(rosterId) ??
        `Roster ${rosterId}`
      );
    };

    // Player map for page
    const playerIds = uniq(
      rows.flatMap((t: any) => t.assets).map((a: any) => a.playerId).filter((x: any) => !!x)
    ) as string[];

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

    // Pick label: use rawJson.draft_picks[*].roster_id (whose pick slot)
    function pickLabel(t: any, a: any) {
      const ys = typeof a.pickSeason === "number" ? a.pickSeason : null;
      const rd = typeof a.pickRound === "number" ? a.pickRound : null;

      const seasonForNames = ys ?? t.season;
      const lidForNames =
        (ys && seasonToLeagueId.get(ys)) || seasonToLeagueId.get(t.season) || t.leagueId;

      const draftPicks: any[] = Array.isArray(t.rawJson?.draft_picks) ? t.rawJson.draft_picks : [];

      const match = draftPicks.find((p) => {
        const ps = Number(p?.season);
        const pr = Number(p?.round);
        if (!Number.isFinite(ps) || !Number.isFinite(pr)) return false;
        if (ys !== null && ps !== ys) return false;
        if (rd !== null && pr !== rd) return false;

        const prev = p?.previous_owner_id;
        const owner = p?.owner_id;
        if (typeof a.fromRosterId === "number" && typeof a.toRosterId === "number") {
          if (prev === a.fromRosterId && owner === a.toRosterId) return true;
        }
        return true;
      });

      const originalRoster = typeof match?.roster_id === "number" ? (match.roster_id as number) : null;
      const originalTeam =
        originalRoster !== null ? rosterLabel(lidForNames, seasonForNames, originalRoster) : null;

      const prefix = originalTeam ? `(${originalTeam} pick) ` : "";
      const core = `${ys ?? "?"} R${rd ?? "?"}`;
      return `${prefix}${core}`;
    }

    function assetLabel(t: any, a: any) {
      if (a.kind === "pick") return pickLabel(t, a);
      if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
      if (a.playerId) return playerLabel(a.playerId);
      return a.kind ?? "asset";
    }

    const items: TxItem[] = rows.map((t: any) => {
      const involvedRosterIds = uniq(
        t.assets
          .flatMap((a: any) => [a.fromRosterId, a.toRosterId])
          .filter((x: any) => typeof x === "number")
      ) as number[];

      const teams = involvedRosterIds
        .map((rid) => rosterLabel(t.leagueId, t.season, rid))
        .filter((x) => x !== "—");

      // TRADE
      if (t.type === "trade") {
        const recvMap = new Map<number, string[]>();
        const sentMap = new Map<number, string[]>();

        for (const a of t.assets) {
          const from = a.fromRosterId;
          const to = a.toRosterId;
          if (typeof from === "number" && typeof to === "number" && from !== to) {
            const recv = recvMap.get(to) ?? [];
            recv.push(assetLabel(t, a));
            recvMap.set(to, recv);

            const sent = sentMap.get(from) ?? [];
            sent.push(assetLabel(t, a));
            sentMap.set(from, sent);
          }
        }

        const received = Array.from(recvMap.entries())
          .map(([rid, list]) => ({
            rosterId: rid,
            team: rosterLabel(t.leagueId, t.season, rid),
            items: list,
          }))
          .sort((a, b) => a.rosterId - b.rosterId);

        const sent = Array.from(sentMap.entries())
          .map(([rid, list]) => ({
            rosterId: rid,
            team: rosterLabel(t.leagueId, t.season, rid),
            items: list,
          }))
          .sort((a, b) => a.rosterId - b.rosterId);

        return {
          id: t.id,
          leagueId: t.leagueId,
          season: t.season,
          type: t.type,
          typeLabel: prettyType(t.type),
          createdAt: t.createdAt.toISOString(),
          teams,
          received,
          sent,
        };
      }

      // NON-TRADE (free_agent / waiver / commissioner etc.)
      const addedMap = new Map<number, { items: string[]; faab?: number }>();
      const droppedMap = new Map<number, string[]>();

      // FAAB bid is usually on rawJson.settings.waiver_bid
      const waiverBidRaw = Number(t.rawJson?.settings?.waiver_bid);
      const waiverBid = Number.isFinite(waiverBidRaw) && waiverBidRaw > 0 ? waiverBidRaw : undefined;

      for (const a of t.assets) {
        const from = a.fromRosterId;
        const to = a.toRosterId;

        // adds (FA/waiver signings)
        if ((from === null || from === undefined) && typeof to === "number") {
          const entry = addedMap.get(to) ?? { items: [], faab: undefined };
          entry.items.push(assetLabel(t, a));
          if (t.type === "waiver" && waiverBid !== undefined) entry.faab = waiverBid;
          addedMap.set(to, entry);
        }

        // drops
        if ((to === null || to === undefined) && typeof from === "number") {
          const list = droppedMap.get(from) ?? [];
          list.push(assetLabel(t, a));
          droppedMap.set(from, list);
        }
      }

      const added = Array.from(addedMap.entries())
        .map(([rid, entry]) => ({
          rosterId: rid,
          team: rosterLabel(t.leagueId, t.season, rid),
          items: entry.items,
          faab: entry.faab,
        }))
        .sort((a, b) => a.rosterId - b.rosterId);

      const dropped = Array.from(droppedMap.entries())
        .map(([rid, list]) => ({
          rosterId: rid,
          team: rosterLabel(t.leagueId, t.season, rid),
          items: list,
        }))
        .sort((a, b) => a.rosterId - b.rosterId);

      return {
        id: t.id,
        leagueId: t.leagueId,
        season: t.season,
        type: t.type,
        typeLabel: prettyType(t.type),
        createdAt: t.createdAt.toISOString(),
        teams,
        received: [],
        sent: [],
        added,
        dropped,
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
