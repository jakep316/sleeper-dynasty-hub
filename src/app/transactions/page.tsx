import { db } from "@/lib/db";
import FiltersClient from "./FiltersClient";
import { getLeague } from "@/lib/sleeper";

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

async function getLeagueChainIds(startLeagueId: string, max = 20) {
  const ids: string[] = [];
  let cur: string | null = startLeagueId;

  while (cur && ids.length < max) {
    ids.push(cur);
    const l: any = await getLeague(cur);
    cur = l?.previous_league_id ?? null;
  }

  return ids;
}

function toInt(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function TransactionsPage({ searchParams }: Props) {
  const rootLeagueId = process.env.SLEEPER_LEAGUE_ID!;
  if (!rootLeagueId) throw new Error("Missing SLEEPER_LEAGUE_ID env var");

  const leagueIds = await getLeagueChainIds(rootLeagueId);

  const seasonParam = searchParams?.season ?? "all";
  const teamParam = searchParams?.team ?? "all";
  const typeParam = searchParams?.type ?? "all";
  const page = Math.max(1, Number(searchParams?.page ?? 1));

  // ---- Filters ----
  const where: any = { leagueId: { in: leagueIds } };
  if (seasonParam !== "all") where.season = Number(seasonParam);
  if (typeParam !== "all") where.type = typeParam;

  if (teamParam !== "all") {
    const teamId = Number(teamParam);
    where.assets = { some: { OR: [{ fromRosterId: teamId }, { toRosterId: teamId }] } };
  }

  // ---- Dropdown data ----
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

  // ---- Roster -> owner label map (for rows on this page) ----
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

  // ---- Player map ----
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

  // ✅ FIX: match the correct draft_picks row using season+round+toRosterId+fromRosterId
  function pickLabel(t: any, a: any) {
    const ys = typeof a.pickSeason === "number" ? a.pickSeason : null;
    const rd = typeof a.pickRound === "number" ? a.pickRound : null;

    if (!ys || !rd) return "Pick";

    const raw = t.rawJson as any;
    const dp = Array.isArray(raw?.draft_picks) ? raw.draft_picks : [];

    const toRid = typeof a.toRosterId === "number" ? a.toRosterId : null;
    const fromRid = typeof a.fromRosterId === "number" ? a.fromRosterId : null;

    // First, try strongest match
    let match =
      dp.find((p: any) => {
        const season = toInt(p?.season);
        const round = toInt(p?.round);
        const owner = toInt(p?.owner_id);
        const prev = toInt(p?.previous_owner_id);
        return (
          season === ys &&
          round === rd &&
          (toRid === null || owner === toRid) &&
          (fromRid === null || prev === fromRid)
        );
      }) ?? null;

    // Fallback: if previous_owner_id is missing in that season payload, match by owner only
    if (!match && toRid !== null) {
      match =
        dp.find((p: any) => {
          const season = toInt(p?.season);
          const round = toInt(p?.round);
          const owner = toInt(p?.owner_id);
          return season === ys && round === rd && owner === toRid;
        }) ?? null;
    }

    const original = toInt(match?.original_owner_id) ?? null;
    const label = original ? rosterLabel(t.leagueId, t.season, original) : null;

    return label ? `${ys} R${rd} (${label} pick)` : `${ys} R${rd}`;
  }

  const assetLabel = (t: any, a: any) => {
    if (a.kind === "pick") return pickLabel(t, a);
    if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
    if (a.playerId) return playerLabel(a.playerId);
    return a.kind ?? "asset";
  };

  // ---- Team dropdown options ----
  const seasonForRosterDropdown =
    seasonParam !== "all" ? Number(seasonParam) : seasons[0] ?? new Date().getFullYear();

  const leagueIdForRosterDropdown =
    transactions.find((t) => t.season === seasonForRosterDropdown)?.leagueId ??
    leagueIds[0] ??
    rootLeagueId;

  const rosterRowsForDropdown = await db.roster.findMany({
    where: { leagueId: leagueIdForRosterDropdown, season: seasonForRosterDropdown },
    select: { rosterId: true },
    orderBy: { rosterId: "asc" },
  });

  const rosterOptions =
    rosterRowsForDropdown.length > 0
      ? rosterRowsForDropdown.map((r) => ({
          id: r.rosterId,
          label: rosterLabel(leagueIdForRosterDropdown, seasonForRosterDropdown, r.rosterId),
        }))
      : Array.from({ length: 20 }, (_, i) => ({ id: i + 1, label: `Roster ${i + 1}` }));

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
      const sent = new Map<number, string[]>();
      const involved = new Set<number>();

      for (const a of t.assets) {
        const from = typeof a.fromRosterId === "number" ? a.fromRosterId : null;
        const to = typeof a.toRosterId === "number" ? a.toRosterId : null;

        const label = assetLabel(t, a);

        if (from !== null) {
          involved.add(from);
          const list = sent.get(from) ?? [];
          list.push(label);
          sent.set(from, list);
        }
        if (to !== null) {
          involved.add(to);
          const list = received.get(to) ?? [];
          list.push(label);
          received.set(to, list);
        }
      }

      const teamIds = Array.from(involved).sort((a, b) => a - b);
      if (teamIds.length === 0) return <span className="text-zinc-400">—</span>;

      return (
        <div className="space-y-3">
          {teamIds.map((rid) => {
            const team = rosterLabel(t.leagueId, t.season, rid);
            const got = received.get(rid) ?? [];
            const gave = sent.get(rid) ?? [];
            return (
              <div key={rid} className="leading-snug">
                <div className="font-semibold text-zinc-900">{team}</div>
                <div className="text-zinc-700">
                  <span className="font-semibold">Received:</span>{" "}
                  {got.length ? got.join(", ") : "—"}
                </div>
                <div className="text-zinc-700">
                  <span className="font-semibold">Sent:</span>{" "}
                  {gave.length ? gave.join(", ") : "—"}
                </div>
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
        rootParam={rootLeagueId}
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
