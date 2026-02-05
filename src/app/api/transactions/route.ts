// src/app/api/transactions/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague } from "@/lib/sleeper";

type Facet = { value: string; label: string };

type TxItem = {
  id: string;
  leagueId: string;
  season: number;
  type: string;
  typeLabel: string;
  createdAt: string;

  teams: string[]; // unique teams involved (labels)

  // For trades: per-team received/sent
  received: { rosterId: number; team: string; items: string[] }[];
  sent: { rosterId: number; team: string; items: string[] }[];

  // For non-trades: show Added/Dropped (and optional FAAB)
  added?: { rosterId: number; team: string; items: string[]; faab?: number }[];
  dropped?: { rosterId: number; team: string; items: string[] }[];
};

type LeagueSeasonRow = { leagueId: string; season: number; previousLeagueId: string | null };

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

// Build chain from DB first; if missing, fall back to Sleeper API and persist into LeagueSeason
async function getLeagueChain(rootLeagueId: string) {
  const leagueIds: string[] = [];
  const seasonToLeagueId = new Map<number, string>();

  let cur: string | null = rootLeagueId;
  let guard = 0;

  while (cur && guard++ < 20) {
    leagueIds.push(cur);

    // 1) try DB
    let row: LeagueSeasonRow | null = await db.leagueSeason.findFirst({
      where: { leagueId: cur },
      select: { leagueId: true, season: true, previousLeagueId: true },
    });

    // 2) if missing, fetch from Sleeper and upsert
    if (!row) {
      const l = await getLeague(cur); // { league_id, season, previous_league_id }
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
        row = { leagueId: cur, season: NaN as any, previousLeagueId: prev };
      }
    }

    if (Number.isFinite(row.season)) seasonToLeagueId.set(row.season, row.leagueId);
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

    // ---- facets across chain ----
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

    // pick a "teamsSeason" for team facet labels (newest season in data)
    const teamsSeason =
      facetSeasons.length > 0 ? Number(facetSeasons[0].value) : new Date().getFullYear();

    // team facet: rosters in rootLeagueId + teamsSeason
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
      // no roster numbers in UI
      label: (rosterIdToRootLabel.get(r.rosterId) || `Roster ${r.rosterId}`).trim(),
    }));

    // ---- fetch page rows (need rawJson for pick original owner lookup) ----
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
          week: true,
          type: true,
          createdAt: true,
          rawJson: true,
          assets: true,
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    // ---- roster labels for any (leagueId, season) on page ----
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

    // ---- player map for page ----
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

    // For picks, label with “(ORIGINAL TEAM pick)” using rawJson.draft_picks[*].roster_id (the pick slot)
    function pickLabel(t: any, a: any) {
      const ys = typeof a.pickSeason === "number" ? a.pickSeason : null;
      const rd = typeof a.pickRound === "number" ? a.pickRound : null;

      const seasonForNames = ys ?? t.season;
      const lidForNames =
        (ys && seasonToLeagueId.get(ys)) || seasonToLeagueId.get(t.season) || t.leagueId;

      const draftPicks: any[] = Array.isArray(t.rawJson?.draft_picks) ? t.rawJson.draft_picks : [];

      // Find matching draft pick object
      const match = draftPicks.find((p) => {
        const ps = Number(p?.season);
        const pr = Number(p?.round);
        if (!Number.isFinite(ps) || !Number.isFinite(pr)) return false;
        if (ys !== null && ps !== ys) return false;
        if (rd !== null && pr !== rd) return false;

        // For trades, also match by movement if possible
        const prev = p?.previous_owner_id;
        const owner = p?.owner_id;
        if (typeof a.fromRosterId === "number" && typeof a.toRosterId === "number") {
          if (prev === a.fromRosterId && owner === a.toRosterId) return true;
        }
        // Otherwise accept season+round match
        return true;
      });

      // Sleeper uses roster_id to indicate whose pick slot it is
      const originalRoster =
        typeof match?.roster_id === "number" ? (match.roster_id as number) : null;

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
      const addedMap = new Map<number, { items: string[]; faab: number }>();
      const droppedMap = new Map<number, string[]>();

      // build FAAB map from rawJson.waiver_budget if present (Sleeper includes this on waivers)
      const wb: Record<string, any> =
        t.rawJson && typeof t.rawJson === "object" && t.rawJson.waiver_budget
          ? t.rawJson.waiver_budget
          : {};

      const faabByRoster = new Map<number, number>();
      for (const [k, v] of Object.entries(wb)) {
        const rid = Number(k);
        const amt = Number(v);
        if (Number.isFinite(rid) && Number.isFinite(amt)) faabByRoster.set(rid, amt);
      }

      for (const a of t.assets) {
        const from = a.fromRosterId;
        const to = a.toRosterId;

        // adds
        if ((from === null || from === undefined) && typeof to === "number") {
          const entry = addedMap.get(to) ?? { items: [], faab: faabByRoster.get(to) ?? 0 };
          entry.items.push(assetLabel(t, a));
          entry.faab = faabByRoster.get(to) ?? entry.faab;
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
          faab: entry.faab && entry.faab > 0 ? entry.faab : undefined,
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
