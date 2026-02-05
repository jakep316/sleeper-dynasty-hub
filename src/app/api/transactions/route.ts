// src/app/api/transactions/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague, getLeagueDrafts, getDraftPicks } from "@/lib/sleeper";

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
 * We consult Sleeper if the chain would otherwise stop and upsert while walking.
 */
async function getLeagueChain(rootLeagueId: string) {
  const leagueIds: string[] = [];
  const seasonToLeagueId = new Map<number, string>();

  let cur: string | null = rootLeagueId;
  let guard = 0;

  while (cur && guard++ < 20) {
    leagueIds.push(cur);

    let row: LeagueSeasonRow | null = await db.leagueSeason.findFirst({
      where: { leagueId: cur },
      select: { leagueId: true, season: true, previousLeagueId: true },
    });

    const needsSleeper =
      !row || row.previousLeagueId === null || !Number.isFinite(Number(row.season));

    if (needsSleeper) {
      const l = await getLeague(cur);
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

    if (!row) break;

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

    // Server-side player filter (selected player id from autocomplete)
    const playerId = (url.searchParams.get("playerId") || "").trim() || null;

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

    if (playerId) {
      const existing = where.assets;
      if (existing?.some) {
        where.assets = { some: { AND: [existing.some, { playerId }] } };
      } else {
        where.assets = { some: { playerId } };
      }
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

    // Filter labels should not show roster numbers; just name/owner
    const facetTeams: Facet[] = teamRosters.map((r) => ({
      value: String(r.rosterId),
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

    // Player map for page (players referenced in transaction assets)
    const pagePlayerIds = uniq(
      rows.flatMap((t: any) => t.assets).map((a: any) => a.playerId).filter((x: any) => !!x)
    ) as string[];

    const pagePlayers =
      pagePlayerIds.length > 0
        ? await db.sleeperPlayer.findMany({
            where: { id: { in: pagePlayerIds } },
            select: { id: true, fullName: true, position: true, team: true },
          })
        : [];

    const pagePlayerMap = new Map(pagePlayers.map((p) => [p.id, p]));

    // Full player label for player assets in transactions (keep POS/TEAM here)
    const playerLabel = (id: string) => {
      const p = pagePlayerMap.get(id);
      if (!p) return `Player ${id}`;
      const name = p.fullName ?? `Player ${id}`;
      const parts = [p.position, p.team].filter(Boolean);
      return parts.length ? `${name} (${parts.join(", ")})` : name;
    };

    // ---- Draft pick "used on" lookup (request-level cache) ----
    // key: `${leagueId}::${season}::${rosterId}::${round}` -> playerId
    const draftedPlayerIdBySlot = new Map<string, string | null>();
    const draftLoadedForLeagueSeason = new Set<string>();

    async function loadDraftSlotMapFor(leagueIdForSeason: string, season: number) {
      const key = `${leagueIdForSeason}::${season}`;
      if (draftLoadedForLeagueSeason.has(key)) return;
      draftLoadedForLeagueSeason.add(key);

      try {
        const drafts = await getLeagueDrafts(leagueIdForSeason);
        const seasonStr = String(season);

        const candidates = (drafts || []).filter((d) => {
          const ds = d?.season == null ? "" : String(d.season);
          const okSeason = ds === seasonStr;
          const okStatus = (d.status ?? "").toLowerCase() === "complete";
          return okSeason && okStatus;
        });

        const preferred =
          candidates.find((d) => (d.type ?? "").toLowerCase().includes("rookie")) ?? candidates[0];

        if (!preferred?.draft_id) return;

        const picks = await getDraftPicks(preferred.draft_id);
        for (const p of picks || []) {
          const round = Number((p as any)?.round);
          const rosterId = Number((p as any)?.roster_id);
          if (!Number.isFinite(round) || !Number.isFinite(rosterId)) continue;

          const pid = ((p as any)?.player_id ?? null) as string | null;
          draftedPlayerIdBySlot.set(`${leagueIdForSeason}::${season}::${rosterId}::${round}`, pid);
        }
      } catch {
        // best-effort only
      }
    }

    // Pre-load draft lookups for any picks on this page
    const neededDraftLookups = new Set<string>(); // `${lidForNames}::${ys}`
    for (const t of rows as any[]) {
      for (const a of t.assets || []) {
        if (a.kind !== "pick") continue;
        const ys = typeof a.pickSeason === "number" ? a.pickSeason : null;
        if (ys === null) continue;
        const lidForNames = seasonToLeagueId.get(ys) || seasonToLeagueId.get(t.season) || t.leagueId;
        neededDraftLookups.add(`${lidForNames}::${ys}`);
      }
    }

    for (const k of neededDraftLookups) {
      const [lid, s] = k.split("::");
      const season = Number(s);
      if (!lid || !Number.isFinite(season)) continue;
      await loadDraftSlotMapFor(lid, season);
    }

    // Load drafted player rows so drafted player NAME shows reliably
    const draftedIds = uniq(
      Array.from(draftedPlayerIdBySlot.values()).filter(
        (x): x is string => typeof x === "string" && x.length > 0
      )
    );

    const draftedPlayers =
      draftedIds.length > 0
        ? await db.sleeperPlayer.findMany({
            where: { id: { in: draftedIds } },
            select: { id: true, fullName: true },
          })
        : [];

    const draftedPlayerNameMap = new Map(draftedPlayers.map((p) => [p.id, p.fullName ?? p.id]));

    // Drafted player label for inside the pick parentheses: JUST the name (no pos/team)
    const draftedPlayerNameOnly = (id: string) => draftedPlayerNameMap.get(id) ?? id;

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

      const originalRoster =
        typeof match?.roster_id === "number" ? (match.roster_id as number) : null;

      const originalTeam =
        originalRoster !== null ? rosterLabel(lidForNames, seasonForNames, originalRoster) : null;

      let draftedName: string | null = null;
      if (ys !== null && rd !== null && originalRoster !== null) {
        const key = `${lidForNames}::${ys}::${originalRoster}::${rd}`;
        const pid = draftedPlayerIdBySlot.get(key);
        if (pid) draftedName = draftedPlayerNameOnly(pid);
      }

      const core = `${ys ?? "?"} R${rd ?? "?"}`;
      if (!originalTeam) return core;

      const extra = draftedName ? ` ${draftedName}` : "";
      return `${core} (${originalTeam} pick${extra})`;
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

      const addedMap = new Map<number, { items: string[]; faab?: number }>();
      const droppedMap = new Map<number, string[]>();

      const wb1 = Number(t.rawJson?.settings?.waiver_budget);
      const wb2 = Number(t.rawJson?.settings?.waiver_bid);
      const waiverBid =
        (Number.isFinite(wb1) && wb1 > 0 ? wb1 : undefined) ??
        (Number.isFinite(wb2) && wb2 > 0 ? wb2 : undefined);

      for (const a of t.assets) {
        const from = a.fromRosterId;
        const to = a.toRosterId;

        if ((from === null || from === undefined) && typeof to === "number") {
          const entry = addedMap.get(to) ?? { items: [], faab: undefined };
          entry.items.push(assetLabel(t, a));
          if (t.type === "waiver" && waiverBid !== undefined) entry.faab = waiverBid;
          addedMap.set(to, entry);
        }

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
