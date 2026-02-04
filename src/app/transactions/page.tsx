import { db } from "@/lib/db";
import FiltersClient from "./FiltersClient";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type Props = {
  searchParams?: {
    season?: string;
    team?: string; // rosterId
    type?: string; // "trade", "free_agent", etc.
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

function prettyType(type: string) {
  // "free_agent" -> "Free Agent"
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default async function TransactionsPage({ searchParams }: Props) {
  const leagueId = process.env.SLEEPER_LEAGUE_ID!;

  const seasonParam = searchParams?.season ?? "all";
  const teamParam = searchParams?.team ?? "all";
  const typeParam = searchParams?.type ?? "all";
  const page = Math.max(1, Number(searchParams?.page ?? 1));

  // ---- Filters ----
  const where: any = { leagueId };
  if (seasonParam !== "all") where.season = Number(seasonParam);
  if (typeParam !== "all") where.type = typeParam;

  if (teamParam !== "all") {
    const teamId = Number(teamParam);
    where.assets = { some: { OR: [{ fromRosterId: teamId }, { toRosterId: teamId }] } };
  }

  // ---- Dropdown data ----
  const [seasonRows, typeRows] = await Promise.all([
    db.transaction.findMany({
      where: { leagueId },
      distinct: ["season"],
      select: { season: true },
      orderBy: { season: "desc" },
    }),
    db.transaction.findMany({
      where: { leagueId },
      distinct: ["type"],
      select: { type: true },
    }),
  ]);

  const seasons = seasonRows.map((s) => s.season);
  const types = (typeRows.map((t) => t.type).filter(Boolean) as string[]).sort();

  // ---- Pull transactions ----
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

  // ---- Build roster -> owner label map for any (leagueId, season) on this page ----
  const leagueSeasonPairs = Array.from(
    new Set(transactions.map((t) => `${t.leagueId}::${t.season}`))
  ).map((k) => {
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

  // ---- Player map for page ----
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

  const playerLabel = (id: string) => {
    const p = playerMap.get(id);
    if (!p) return `Player ${id}`;
    const name = p.fullName ?? `Player ${id}`;
    const parts = [p.position, p.team].filter(Boolean);
    return parts.length ? `${name} (${parts.join(", ")})` : name;
  };

  // ---- Team dropdown options (current selected season or newest) ----
  const seasonForRosterDropdown =
    seasonParam !== "all" ? Number(seasonParam) : seasons[0] ?? new Date().getFullYear();

  const rosterRowsForDropdown = await db.roster.findMany({
    where: { leagueId, season: seasonForRosterDropdown },
    select: { rosterId: true },
    orderBy: { rosterId: "asc" },
  });

  const rosterOptions =
    rosterRowsForDropdown.length > 0
      ? rosterRowsForDropdown.map((r) => ({
          id: r.rosterId,
          label: rosterLabel(leagueId, seasonForRosterDropdown, r.rosterId),
        }))
      : Array.from({ length: 20 }, (_, i) => ({ id: i + 1, label: `Roster ${i + 1}` }));

  // ---- Helpers for table columns ----
  function getTeamsString(t: any) {
    const from = new Set<number>();
    const to = new Set<number>();

    for (const a of t.assets) {
      if (typeof a.fromRosterId === "number") from.add(a.fromRosterId);
      if (typeof a.toRosterId === "number") to.add(a.toRosterId);
    }

    const fromLabels = Array.from(from).map((rid) => rosterLabel(t.leagueId, t.season, rid));
    const toLabels = Array.from(to).map((rid) => rosterLabel(t.leagueId, t.season, rid));

    // Trades: show A ↔ B
    if (fromLabels.length && toLabels.length) {
      const left = fromLabels.join(", ");
      const right = toLabels.join(", ");
      if (left !== right) return `${left} ↔ ${right}`;
      // same team movement (add/drop) -> show just team
      return left;
    }

    // Add only or drop only -> show the team involved
    if (fromLabels.length) return fromLabels.join(", ");
    if (toLabels.length) return toLabels.join(", ");
    return "—";
  }

  function getMoves(t: any) {
    const adds: string[] = [];
    const drops: string[] = [];

    for (const a of t.assets) {
      if (!a.playerId) continue;
      const label = playerLabel(a.playerId);

      if (a.fromRosterId && !a.toRosterId) drops.push(label);
      if (!a.fromRosterId && a.toRosterId) adds.push(label);
    }

    if (!adds.length && !drops.length) return null;

    return (
      <div className="space-y-1">
        {adds.length > 0 && <div className="text-emerald-700">Added: {adds.join(", ")}</div>}
        {drops.length > 0 && <div className="text-rose-700">Dropped: {drops.join(", ")}</div>}
      </div>
    );
  }

  const common = { season: seasonParam, team: teamParam, type: typeParam };

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold">Transactions</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Showing <span className="font-semibold text-zinc-900">{totalCount}</span> total
        </p>
      </div>

      <FiltersClient
        rootParam={leagueId}
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
              <th className="text-left p-3">Teams</th>
              <th className="text-left p-3">Moves</th>
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
                <td className="p-3 whitespace-nowrap">{prettyType(t.type)}</td>
                <td className="p-3 whitespace-nowrap">{getTeamsString(t)}</td>
                <td className="p-3">{getMoves(t) ?? <span className="text-zinc-400">—</span>}</td>
              </tr>
            ))}

            {transactions.length === 0 && (
              <tr>
                <td className="p-6 text-zinc-600" colSpan={6}>
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
