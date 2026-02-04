import { db } from "@/lib/db";
import { getRosterNameMap } from "@/lib/names";

const PAGE_SIZE = 50;

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-semibold text-zinc-700">
      {children}
    </span>
  );
}

function buildQueryString(params: Record<string, string | number | null | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === "all") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const leagueId = process.env.SLEEPER_LEAGUE_ID!;

  const seasonParam = typeof searchParams.season === "string" ? searchParams.season : "all";
  const teamParam = typeof searchParams.team === "string" ? searchParams.team : "all"; // rosterId
  const typeParam = typeof searchParams.type === "string" ? searchParams.type : "all";
  const pageParam = typeof searchParams.page === "string" ? searchParams.page : "1";

  const season = seasonParam !== "all" ? Number(seasonParam) : null;
  const team = teamParam !== "all" ? Number(teamParam) : null;
  const page = Math.max(1, Number(pageParam) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  // Build filter for transactions
  const txWhere: any = {
    leagueId,
    ...(season ? { season } : {}),
    ...(typeParam !== "all" ? { type: typeParam } : {}),
  };

  // If filtering by team, we filter transactions that have any asset with from/to roster matching
  let txIdsFilter: string[] | null = null;
  if (team !== null && Number.isFinite(team)) {
    const matchingAssets = await db.transactionAsset.findMany({
      where: {
        ...(season ? {} : {}), // assets don't have season; they link via transactionId
        OR: [{ fromRosterId: team }, { toRosterId: team }],
        transaction: {
          leagueId,
          ...(season ? { season } : {}),
          ...(typeParam !== "all" ? { type: typeParam } : {}),
        },
      },
      select: { transactionId: true },
    });

    txIdsFilter = Array.from(new Set(matchingAssets.map((a) => a.transactionId)));
    if (txIdsFilter.length === 0) {
      // No matches -> render empty state with filters UI
      return (
        <div className="grid gap-4">
          <Header leagueId={leagueId} />
          <Filters
            leagueId={leagueId}
            seasonParam={seasonParam}
            teamParam={teamParam}
            typeParam={typeParam}
          />
          <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm text-sm text-zinc-600">
            No transactions match those filters.
          </div>
        </div>
      );
    }
    txWhere.id = { in: txIdsFilter };
  }

  // Filter dropdown data
  const seasons = await db.transaction.findMany({
    where: { leagueId },
    distinct: ["season"],
    select: { season: true },
    orderBy: { season: "desc" },
  });

  const types = await db.transaction.findMany({
    where: { leagueId, ...(season ? { season } : {}) },
    distinct: ["type"],
    select: { type: true },
  });

  // Count for pagination
  const total = await db.transaction.count({ where: txWhere });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const txs = await db.transaction.findMany({
    where: txWhere,
    orderBy: [{ season: "desc" }, { week: "desc" }, { createdAt: "desc" }],
    take: PAGE_SIZE,
    skip,
  });

  // Assets for shown page
  const txIds = txs.map((t) => t.id);
  const assets =
    txIds.length > 0
      ? await db.transactionAsset.findMany({
          where: { transactionId: { in: txIds } },
          orderBy: [{ transactionId: "asc" }, { id: "asc" }],
        })
      : [];

  const assetsByTx = new Map<string, typeof assets>();
  for (const a of assets) {
    const arr = assetsByTx.get(a.transactionId) ?? [];
    arr.push(a);
    assetsByTx.set(a.transactionId, arr);
  }

  // Player names lookup
  const playerIds = Array.from(
    new Set(
      assets
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
    const pos = p.position ? ` ${p.position}` : "";
    const team = p.team ? ` – ${p.team}` : "";
    return `${name}${pos}${team}`;
  };

  // Names: best effort. If a season is selected, names will be accurate for that season.
  // If season=all, we use newest season names (still readable).
  const seasonForNames = season ?? (seasons[0]?.season ?? new Date().getFullYear());
  const rosterNames = await getRosterNameMap(leagueId, seasonForNames);
  const nameOf = (id: number | null) => (id == null ? "—" : rosterNames.get(id) ?? `Roster ${id}`);

  return (
    <div className="grid gap-4">
      <Header leagueId={leagueId} />

      <Filters
        leagueId={leagueId}
        seasonParam={seasonParam}
        teamParam={teamParam}
        typeParam={typeParam}
        seasons={seasons.map((s) => s.season)}
        types={types.map((t) => t.type).filter(Boolean) as string[]}
      />

      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm text-sm text-zinc-600 flex flex-wrap gap-3 items-center justify-between">
        <div>
          Showing <span className="font-semibold text-zinc-900">{txs.length}</span> of{" "}
          <span className="font-semibold text-zinc-900">{total}</span>
        </div>
        <Pagination
          page={page}
          totalPages={totalPages}
          seasonParam={seasonParam}
          teamParam={teamParam}
          typeParam={typeParam}
        />
      </div>

      <div className="grid gap-3">
        {txs.map((t) => {
          const a = assetsByTx.get(t.id) ?? [];
          return (
            <div key={t.id} className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold">
                    Season {t.season} • Week {t.week} <span className="text-zinc-300">•</span> {t.type}
                  </div>
                  <Badge>{t.status}</Badge>
                </div>
                <div className="text-xs text-zinc-500">{t.id}</div>
              </div>

              {a.length > 0 ? (
                <div className="mt-3 grid gap-2">
                  {a.slice(0, 12).map((x, i) => {
                    const label =
                      x.kind === "pick"
                        ? `Pick ${x.pickSeason ?? "?"} R${x.pickRound ?? "?"}`
                        : x.kind === "faab"
                        ? `FAAB $${x.faabAmount ?? 0}`
                        : x.kind === "player" || x.kind === "player_drop"
                        ? playerLabel(x.playerId ?? "")
                        : x.kind;

                    return (
                      <div key={`${t.id}-${i}`} className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm text-zinc-800">
                          <span className="font-medium">{label}</span>
                        </div>
                        <div className="text-sm text-zinc-600">
                          {nameOf(x.fromRosterId)} <span className="text-zinc-300">→</span> {nameOf(x.toRosterId)}
                        </div>
                      </div>
                    );
                  })}
                  {a.length > 12 && <div className="text-xs text-zinc-500">…and {a.length - 12} more</div>}
                </div>
              ) : (
                <div className="mt-3 text-sm text-zinc-500">No asset details stored for this transaction.</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
        <Pagination
          page={page}
          totalPages={totalPages}
          seasonParam={seasonParam}
          teamParam={teamParam}
          typeParam={typeParam}
        />
      </div>
    </div>
  );
}

function Header({ leagueId }: { leagueId: string }) {
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
      <p className="mt-1 text-sm text-zinc-600">Full league history (paginated)</p>
      <p className="mt-2 text-xs text-zinc-500">
        League ID: <span className="font-mono">{leagueId}</span>
      </p>
    </div>
  );
}

function Filters({
  leagueId,
  seasonParam,
  teamParam,
  typeParam,
  seasons = [],
  types = [],
}: {
  leagueId: string;
  seasonParam: string;
  teamParam: string;
  typeParam: string;
  seasons?: number[];
  types?: string[];
}) {
  // For team dropdown we keep it simple (rosterId 1..20). We can replace with actual team names later.
  const rosterOptions = Array.from({ length: 20 }, (_, i) => i + 1);

  const base = { season: seasonParam, team: teamParam, type: typeParam, page: 1 };

  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <label className="text-xs font-semibold text-zinc-600">Season</label>
          <select
            className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            defaultValue={seasonParam}
            onChange={(e) => {
              const qs = buildQueryString({ ...base, season: e.target.value });
              window.location.href = `/transactions${qs}`;
            }}
          >
            <option value="all">All</option>
            {seasons.map((s) => (
              <option key={s} value={String(s)}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-semibold text-zinc-600">Type</label>
          <select
            className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            defaultValue={typeParam}
            onChange={(e) => {
              const qs = buildQueryString({ ...base, type: e.target.value });
              window.location.href = `/transactions${qs}`;
            }}
          >
            <option value="all">All</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-semibold text-zinc-600">Team (Roster)</label>
          <select
            className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            defaultValue={teamParam}
            onChange={(e) => {
              const qs = buildQueryString({ ...base, team: e.target.value });
              window.location.href = `/transactions${qs}`;
            }}
          >
            <option value="all">All</option>
            {rosterOptions.map((r) => (
              <option key={r} value={String(r)}>
                Roster {r}
              </option>
            ))}
          </select>
        </div>

        <a
          href="/transactions"
          className="ml-auto rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
        >
          Clear
        </a>
      </div>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  seasonParam,
  teamParam,
  typeParam,
}: {
  page: number;
  totalPages: number;
  seasonParam: string;
  teamParam: string;
  typeParam: string;
}) {
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const common = { season: seasonParam, team: teamParam, type: typeParam };

  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <a
        className={`rounded-xl px-3 py-2 font-semibold ${
          page <= 1 ? "pointer-events-none text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
        }`}
        href={`/transactions${buildQueryString({ ...common, page: prev })}`}
      >
        ← Prev
      </a>

      <div className="text-zinc-600">
        Page <span className="font-semibold text-zinc-900">{page}</span> of{" "}
        <span className="font-semibold text-zinc-900">{totalPages}</span>
      </div>

      <a
        className={`rounded-xl px-3 py-2 font-semibold ${
          page >= totalPages ? "pointer-events-none text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
        }`}
        href={`/transactions${buildQueryString({ ...common, page: next })}`}
      >
        Next →
      </a>
    </div>
  );
}
