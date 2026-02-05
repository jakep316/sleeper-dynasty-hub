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
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
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

  // ---- Pull transactions (NO select + include together!) ----
  const [totalCount, transactions] = await Promise.all([
    db.transaction.count({ where }),
    db.transaction.findMany({
      where,
      orderBy: [{ season: "desc" }, { week: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { assets: true }, // ✅ keep include
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

  // ---- Player map for page ----
  const playerIds = uniq(
    transactions
      .flatMap((t) => t.assets)
      .map((a) => a.playerId)
      .filter((x): x is string => typeof x === "string" && x.length > 0)
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

  // ---- Pick label helpers ----
  function pickLabel(t: any, a: any) {
    const ys = typeof a.pickSeason === "number" ? String(a.pickSeason) : "?";
    const rd = typeof a.pickRound === "number" ? String(a.pickRound) : "?";

    // Try to determine "whose pick" from rawJson.draft_picks if present
    const raw = t.rawJson as any;
    const dp = Array.isArray(raw?.draft_picks) ? raw.draft_picks : [];

    // Match by season+round and by to/from roster if possible
    const match =
      dp.find((p: any) => {
        const sameSeason = String(p?.season) === ys;
        const sameRound = Number(p?.round) === Number(rd);
        return sameSeason && sameRound;
      }) ?? null;

    // Sleeper draft_picks includes original_owner_id sometimes; otherwise owner_id
    // These are rosterIds in many payloads.
    const original =
      match?.original_owner_id ??
      match?.original_owner_roster_id ??
      match?.owner_id ??
      null;

    const label = original ? rosterLabel(t.leagueId, t.season, Number(original)) : null;

    return label ? `${ys} R${rd} (${label} pick)` : `${ys} R${rd}`;
  }

  const assetLabel = (t: any, a: any) => {
    if (a.kind === "pick") return pickLabel(t, a);
    if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
    if (a.playerId) return playerLabel(a.playerId);
    return a.kind ?? "asset";
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

  // ---- Column renderers ----
  function getTeamsString(t: any) {
    if (t.type === "trade") {
      const involved: number[] = [];
      for (const a of t.assets) {
        if (typeof a.fromRosterId === "number") involved.push(a.fromRosterId);
        if (typeof a.toRosterId === "number") involved.push(a.toRosterId);
      }

      const clean = uniq(involved)
        .map((rid) => rosterLabel(t.leagueId, t.season, rid))
        .filter((x) => x !== "—");

      if (clean.length === 2) return `${clean[0]} ↔ ${clean[1]}`;
      if (clean.length > 2) return clean.join(" ↔ ");
      return clean[0] ?? "—";
    }

    const fromTeams = new Set<number>();
    const toTeams = new Set<number>();

    for (const a of t.assets) {
      if (typeof a.fromRosterId === "number") fromTeams.add(a.fromRosterId);
      if (typeof a.toRosterId === "number") toTeams.add(a.toRosterId);
    }

    const labels = uniq([
      ...Array.from(fromTeams).map((rid) => rosterLabel(t.leagueId, t.season, rid)),
      ...Array.from(toTeams).map((rid) => rosterLabel(t.leagueId, t.season, rid)),
    ]).filter((x) => x !== "—");

    return labels.length ? labels.join(", ") : "—";
  }

  function getMoves(t: any) {
    if (t.type === "trade") {
      const received = new Map<number, string[]>();

      for (const a of t.assets) {
        const from = a.fromRosterId;
        const to = a.toRosterId;

        if (typeof from === "number" && typeof to === "number" && from !== to) {
          const list = received.get(to) ?? [];
          list.push(assetLabel(t, a));
          received.set(to, list);
        }
      }

      const teamIds = Array.from(received.keys()).sort((a, b) => a - b);
      if (teamIds.length === 0) return <span className="text-zinc-400">—</span>;

      return (
        <div className="space-y-2">
          {teamIds.map((rid) => {
            const team = rosterLabel(t.leagueId, t.season, rid);
            const items = received.get(rid) ?? [];
            return (
              <div key={rid} className="leading-snug">
                <div className="font-semibold text-zinc-900">{team} received</div>
                <div className="text-zinc-700">{items.join(", ")}</div>
              </div>
            );
          })}
        </div>
      );
    }

    const adds: string[] = [];
    const drops: string[] = [];

    for (const a of t.assets) {
      if (!a.playerId) continue;
      const label = playerLabel(a.playerId);

      if (a.fromRosterId && !a.toRosterId) drops.push(label);
      if (!a.fromRosterId && a.toRosterId) adds.push(label);
    }

    if (!adds.length && !drops.length) return <span className="text-zinc-400">—</span>;

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
                <td className="p-3">{getMoves(t)}</td>
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
