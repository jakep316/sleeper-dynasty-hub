// src/app/api/transactions/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague } from "@/lib/sleeper";

export const dynamic = "force-dynamic";

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

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

function parseCsvParam(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build full league chain (all seasons) by following previous_league_id.
 * This is the root fix for your "only 2026/2025 show" issue.
 */
async function getLeagueIdChain(rootLeagueId: string) {
  const leagueIds: string[] = [];
  const seen = new Set<string>();

  let current: string | null = rootLeagueId;
  let guard = 0;

  while (current && !seen.has(current) && guard < 30) {
    guard++;
    seen.add(current);
    leagueIds.push(current);

    const l: any = await getLeague(current);
    const prev = l?.previous_league_id ?? null;
    current = prev;
  }

  return leagueIds;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    // Root league id to start chain from (defaults to env)
    const rootLeagueId =
      url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID ?? "";

    if (!rootLeagueId) {
      return NextResponse.json(
        { ok: false, error: "Missing leagueId (and SLEEPER_LEAGUE_ID is not set)" },
        { status: 400 }
      );
    }

    // Filters (support CSV so you can do multi-select later: season=2026,2025 etc)
    const seasonsFilter = parseCsvParam(url.searchParams.get("season"));
    const typesFilter = parseCsvParam(url.searchParams.get("type"));
    const teamsFilter = parseCsvParam(url.searchParams.get("team")); // rosterId(s)

    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const pageSize = Math.min(
      PAGE_SIZE_MAX,
      Math.max(1, Number(url.searchParams.get("pageSize") ?? String(PAGE_SIZE_DEFAULT)))
    );

    // ✅ IMPORTANT: full chain of league IDs (2026..2021)
    const leagueIds = await getLeagueIdChain(rootLeagueId);

    // Build Prisma where clause
    const where: any = { leagueId: { in: leagueIds } };

    if (seasonsFilter.length > 0) {
      const nums = seasonsFilter.map((s) => Number(s)).filter((n) => Number.isFinite(n));
      if (nums.length > 0) where.season = { in: nums };
    }

    if (typesFilter.length > 0) {
      where.type = { in: typesFilter };
    }

    if (teamsFilter.length > 0) {
      const teamNums = teamsFilter.map((s) => Number(s)).filter((n) => Number.isFinite(n));
      if (teamNums.length > 0) {
        where.assets = {
          some: {
            OR: [{ fromRosterId: { in: teamNums } }, { toRosterId: { in: teamNums } }],
          },
        };
      }
    }

    // Fetch transactions + count
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

    // Facets (✅ also across league chain)
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

    const facetSeasons = seasonRows.map((s) => s.season);
    const facetTypes = (typeRows.map((t) => t.type).filter(Boolean) as string[]).sort();

    // Build roster -> owner label map for all (leagueId, season) that appear on this page
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

    // Player label map for page
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

    const pickLabel = (t: any, a: any) => {
      // Optional: if you later store original owner metadata, enrich here.
      const ys = typeof a.pickSeason === "number" ? String(a.pickSeason) : "?";
      const rd = typeof a.pickRound === "number" ? String(a.pickRound) : "?";
      return `${ys} R${rd}`;
    };

    const assetLabel = (t: any, a: any) => {
      if (a.kind === "pick") return pickLabel(t, a);
      if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
      if (a.playerId) return playerLabel(a.playerId);
      return a.kind ?? "asset";
    };

    // Build per-transaction "received/sent" blocks (trade vs non-trade)
    function buildTxView(t: any) {
      const involvedTeams: number[] = [];
      for (const a of t.assets) {
        if (typeof a.fromRosterId === "number") involvedTeams.push(a.fromRosterId);
        if (typeof a.toRosterId === "number") involvedTeams.push(a.toRosterId);
      }
      const teams = uniq(involvedTeams)
        .map((rid) => rosterLabel(t.leagueId, t.season, rid))
        .filter((x) => x !== "—");

      if (t.type === "trade") {
        const received = new Map<number, string[]>();
        const sent = new Map<number, string[]>();

        for (const a of t.assets) {
          const from = a.fromRosterId;
          const to = a.toRosterId;

          if (typeof from === "number" && typeof to === "number" && from !== to) {
            const r = received.get(to) ?? [];
            r.push(assetLabel(t, a));
            received.set(to, r);

            const s = sent.get(from) ?? [];
            s.push(assetLabel(t, a));
            sent.set(from, s);
          }
        }

        const allIds = uniq([...Array.from(received.keys()), ...Array.from(sent.keys())]).sort(
          (a, b) => a - b
        );

        return {
          id: t.id,
          leagueId: t.leagueId,
          season: t.season,
          week: t.week,
          type: t.type,
          typeLabel: prettyType(t.type),
          createdAt: t.createdAt,
          teams,
          received: allIds
            .map((rid) => ({
              rosterId: rid,
              team: rosterLabel(t.leagueId, t.season, rid),
              items: received.get(rid) ?? [],
            }))
            .filter((x) => x.items.length > 0),
          sent: allIds
            .map((rid) => ({
              rosterId: rid,
              team: rosterLabel(t.leagueId, t.season, rid),
              items: sent.get(rid) ?? [],
            }))
            .filter((x) => x.items.length > 0),
        };
      }

      // Non-trade: treat "toRosterId = received", "fromRosterId = sent"
      const received = new Map<number, string[]>();
      const sent = new Map<number, string[]>();

      for (const a of t.assets) {
        const from = a.fromRosterId;
        const to = a.toRosterId;

        if (typeof to === "number" && !Number.isNaN(to)) {
          const r = received.get(to) ?? [];
          r.push(assetLabel(t, a));
          received.set(to, r);
        }
        if (typeof from === "number" && !Number.isNaN(from)) {
          const s = sent.get(from) ?? [];
          s.push(assetLabel(t, a));
          sent.set(from, s);
        }
      }

      const allIds = uniq([...Array.from(received.keys()), ...Array.from(sent.keys())]).sort(
        (a, b) => a - b
      );

      return {
        id: t.id,
        leagueId: t.leagueId,
        season: t.season,
        week: t.week,
        type: t.type,
        typeLabel: prettyType(t.type),
        createdAt: t.createdAt,
        teams,
        received: allIds
          .map((rid) => ({
            rosterId: rid,
            team: rosterLabel(t.leagueId, t.season, rid),
            items: received.get(rid) ?? [],
          }))
          .filter((x) => x.items.length > 0),
        sent: allIds
          .map((rid) => ({
            rosterId: rid,
            team: rosterLabel(t.leagueId, t.season, rid),
            items: sent.get(rid) ?? [],
          }))
          .filter((x) => x.items.length > 0),
      };
    }

    const items = rows.map(buildTxView);

    // Teams facet: show teams for most recent season in chain (or selected season if filtered)
    const teamsSeason =
      seasonsFilter.length > 0
        ? Number(seasonsFilter[0])
        : (facetSeasons[0] ?? new Date().getFullYear());

    const leagueForTeamsSeason = leagueIds.find((lid) => {
      // If you want to be perfect, map season->leagueId by calling getLeague for each lid.
      // For now: rosters are stored with the correct leagueId+season in DB, so we’ll just query all.
      return true;
    });

    // Pull rosters for the season across chain (in case leagueId differs)
    const rostersForSeason = await db.roster.findMany({
      where: { season: teamsSeason, leagueId: { in: leagueIds } },
      select: { leagueId: true, season: true, rosterId: true },
      orderBy: { rosterId: "asc" },
    });

    const teamsFacet = rostersForSeason.map((r) => ({
      value: String(r.rosterId),
      label: rosterLabel(r.leagueId, r.season, r.rosterId),
    }));

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
        teams: teamsFacet,
        teamsSeason,
        // keep around in case you want it client-side:
        leagueForTeamsSeason: leagueForTeamsSeason ?? null,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
