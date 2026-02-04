import { db } from "@/lib/db";
import { getLeague } from "@/lib/sleeper";
import FiltersClient from "./FiltersClient";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type Props = {
  searchParams?: {
    season?: string;
    team?: string;
    type?: string;
    page?: string;
  };
};

function buildQueryString(params: Record<string, string | number | null | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === "all") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getLeagueIdChain(startLeagueId: string, maxDepth = 25) {
  const chain: Array<{ leagueId: string; season: number; previous: string | null }> = [];
  const seen = new Set<string>();
  let current: string | null = startLeagueId;

  for (let i = 0; i < maxDepth && current; i++) {
    if (seen.has(current)) break;
    seen.add(current);

    const meta = await getLeague(current);
    chain.push({
      leagueId: meta.league_id,
      season: Number(meta.season),
      previous: meta.previous_league_id ?? null,
    });

    current = meta.previous_league_id ?? null;
  }

  return chain;
}

export default async function TransactionsPage({ searchParams }: Props) {
  const rootLeagueId = process.env.SLEEPER_LEAGUE_ID!;

  const seasonParam = searchParams?.season ?? "all";
  const teamParam = searchParams?.team ?? "all";
  const typeParam = searchParams?.type ?? "all";
  const page = Math.max(1, Number(searchParams?.page ?? 1));

  // Build chain with season mapping
  const chain = await getLeagueIdChain(rootLeagueId);
  const leagueIds = chain.map((c) => c.leagueId);

  // Determine which leagueId to use for roster label lookups
  // If user selects a season, use the leagueId that matches that season.
  const labelLeagueId =
    seasonParam !== "all"
      ? chain.find((c) => c.season === Number(seasonParam))?.leagueId ?? rootLeagueId
      : rootLeagueId;

  // Filters for DB query (across ALL leagueIds)
  const where: any = { leagueId: { in: leagueIds } };
  if (seasonParam !== "all") where.season = Number(seasonParam);
  if (typeParam !== "all") where.type = typeParam;

  if (teamParam !== "all") {
    const teamId = Number(teamParam);
    where.assets = { some: { OR: [{ fromRosterId: teamId }, { toRosterId: teamId }] } };
  }

  // Dropdown seasons + types from DB (across the chain)
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

  const seasons = seasonRows.map((s) => s.season);
  const types = (typeRows.map((t) => t.type).filter(Boolean) as string[]).sort();

  // Query transactions
  const [totalCount, transactions] = await Promise.all([
    db.transaction.count({ where }),
    db.transaction.findMany({
      where,
      orderBy: [{ season: "desc" }, { week: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { assets: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Player map for playerIds shown on this page
  const playerIds = Array.from(
    new Set(
      transactions
        .flatMap((t) => t.assets)
        .map((a) => a.playerId)
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    )
  );

  const players =
    playerIds.length > 0
      ? await db.sleeperPlayer.findMany({
          where: { id: { in: playerIds } },
          select: { id: true, fullName: true, position: true, team: true },
        })
      : [];

  const playerMap = new Map(players.map((p) => [p.id, p]));

  const playerLabel = (playerId: string) => {
    const p = playerMap.get(playerId);
    if (!p) return `Player ${playerId}`;
    const name = p.fullName ?? `Player ${playerId}`;
    const pos = p.position ? p.position : "";
    const team = p.team ? p.team : "";
    const suffix = pos || team ? ` (${[pos, team].filter(Boolean).join(", ")})` : "";
    return `${name}${suffix}`;
  };

  const renderAsset = (a: any) => {
    if (a.kind === "player" || a.kind === "player_drop") return playerLabel(a.playerId ?? "");
    if (a.kind === "pick") return `${a.pickSeason ?? "?"} Round ${a.pickRound ?? "?"}`;
    if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
    return a.kind ?? "asset";
  };

  // Roster dropdown labels (use the leagueId for the selected season)
  const seasonForRosterLabels =
    seasonParam !== "all" ? Number(seasonParam) : seasons[0] ?? new Date().getFullYear();

  const rosterRows = await db.roster.findMany({
    where: { leagueId: labelLeagueId, season: seasonForRosterLabels },
    select: { rosterId: true, ownerId: true },
    orderBy: { rosterId: "asc" },
  });

  const ownerIds = Array.from(
    new Set(rosterRows.map((r) => r.ownerId).filter((x): x is string => !!x))
  );

  const owners =
    ownerIds.length > 0
      ? await db.sleeperUser.findMany({
          where: { sleeperUserId: { in: ownerIds } },
          select: { sleeperUserId: true, displayName: true, username: true },
        })
      : [];

  const ownerMap = new Map(owners.map((o) => [o.sleeperUserId, o]));

  const rosterOptions =
    rosterRows.length > 0
      ? rosterRows.map((r) => {
          const o = r.ownerId ? ownerMap.get(r.ownerId) : null;
          const label =
            o?.displayName || o?.username
              ? `${o.displayName ?? o.username} (Roster ${r.rosterId})`
              : `Roster ${r.rosterId}`;
          return { id: r.rosterId, label };
        })
      : Array.from({ length: 20 }, (_, i) => ({ id: i + 1, label: `Roster ${i + 1}` }));

  const common = { season: seasonParam, team: teamParam, type: typeParam };

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold">Transactions</h1>
        <p className="mt-1 text-sm text-zinc-600">
          League chain: {chain.map((c) => `${c.season}`).join(" → ")} (count: {chain.length})
        </p>
      </div>

      <FiltersClient
        seasonParam={seasonParam}
        teamParam={teamParam}
        typeParam={typeParam}
        seasons={seasons}
        types={types}
        rosters={rosterOptions}
      />

      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm text-sm text-zinc-600 flex flex-wrap gap-3 items-center justify-between">
        <div>
          Showing <span className="font-semibold text-zinc-900">{transactions.length}</span> of{" "}
          <span className="font-semibold text-zinc-900">{totalCount}</span>
        </div>

        <div className="flex items-center gap-3">
          <a
            className={`rounded-xl px-3 py-2 font-semibold ${
              page <= 1 ? "pointer-events-none text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
            }`}
            href={`/transactions${buildQueryString({ ...common, page: page - 1 })}`}
          >
            ← Prev
          </a>

          <div className="text-zinc-600">
            Page <span className="font-semibold text-zinc-900">{page}</span> of{" "}
            <span className="font-semibold text-zinc-900">{totalPages}</span>
          </div>

          <a
            className={`rounded-xl px-3 py-2 font-semibold ${
              page >= totalPages
                ? "pointer-events-none text-zinc-400"
                : "text-zinc-900 hover:bg-zinc-100"
            }`}
            href={`/transactions${buildQueryString({ ...common, page: page + 1 })}`}
          >
            Next →
          </a>
        </div>
      </div>

      <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-600">
            <tr>
              <th className="text-left p-3">Season</th>
              <th className="text-left p-3">Week</th>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">Type</th>
              <th className="text-left p-3">Assets</th>
            </tr>
          </thead>

          <tbody>
            {transactions.map((t) => (
              <tr key={t.id} className="border-t align-top">
                <td className="p-3 whitespace-nowrap">{t.season}</td>
                <td className="p-3 whitespace-nowrap">{t.week}</td>
                <td className="p-3 whitespace-nowrap">
                  {new Date(t.createdAt).toLocaleDateString()}
                </td>
                <td className="p-3 capitalize whitespace-nowrap">{t.type}</td>
                <td className="p-3">
                  {t.assets.length === 0 ? (
                    <span className="text-zinc-400">No assets recorded</span>
                  ) : (
                    <ul className="space-y-1">
                      {t.assets.slice(0, 12).map((a: any, i: number) => (
                        <li key={i}>{renderAsset(a)}</li>
                      ))}
                      {t.assets.length > 12 && (
                        <li className="text-zinc-400">…and {t.assets.length - 12} more</li>
                      )}
                    </ul>
                  )}
                </td>
              </tr>
            ))}

            {transactions.length === 0 && (
              <tr>
                <td className="p-6 text-zinc-600" colSpan={5}>
                  No transactions found with the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
