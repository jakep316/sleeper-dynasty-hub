import { db } from "@/lib/db";
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

export default async function TransactionsPage({ searchParams }: Props) {
  const rootLeagueId = process.env.SLEEPER_LEAGUE_ID!;

  const seasonParam = searchParams?.season ?? "all";
  const page = Math.max(1, Number(searchParams?.page ?? 1));

  const where: any = { leagueId: rootLeagueId };
  if (seasonParam !== "all") where.season = Number(seasonParam);

  const [transactions] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: [{ season: "desc" }, { week: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { assets: true },
    }),
  ]);

  /* ---------------------------------------
     Owner / roster lookup
  ----------------------------------------*/

  const rosterRows = await db.roster.findMany({
    where: { leagueId: rootLeagueId },
    select: { rosterId: true, ownerId: true, season: true },
  });

  const ownerIds = rosterRows.map((r) => r.ownerId).filter(Boolean) as string[];

  const owners = await db.sleeperUser.findMany({
    where: { sleeperUserId: { in: ownerIds } },
    select: { sleeperUserId: true, displayName: true, username: true },
  });

  const ownerMap = new Map(owners.map((o) => [o.sleeperUserId, o.displayName ?? o.username]));

  const rosterLabelMap = new Map<number, string>();
  for (const r of rosterRows) {
    rosterLabelMap.set(
      r.rosterId,
      ownerMap.get(r.ownerId ?? "") ?? `Roster ${r.rosterId}`
    );
  }

  const rosterLabel = (id: number | null | undefined) =>
    id ? rosterLabelMap.get(id) ?? `Roster ${id}` : "—";

  /* ---------------------------------------
     Player names
  ----------------------------------------*/

  const playerIds = Array.from(
    new Set(
      transactions.flatMap((t) =>
        t.assets.map((a) => a.playerId).filter(Boolean)
      )
    )
  ) as string[];

  const players = await db.sleeperPlayer.findMany({
    where: { id: { in: playerIds } },
    select: { id: true, fullName: true, position: true, team: true },
  });

  const playerMap = new Map(players.map((p) => [p.id, p]));

  const playerLabel = (id: string) => {
    const p = playerMap.get(id);
    if (!p) return id;
    return `${p.fullName} (${p.position}, ${p.team})`;
  };

  /* ---------------------------------------
     NEW: Smart team summary logic
  ----------------------------------------*/

  function summarizeTransaction(t: any) {
    const adds: string[] = [];
    const drops: string[] = [];

    const from = new Set<number>();
    const to = new Set<number>();

    for (const a of t.assets) {
      if (a.playerId) {
        const label = playerLabel(a.playerId);

        if (a.fromRosterId && !a.toRosterId) drops.push(label);
        if (!a.fromRosterId && a.toRosterId) adds.push(label);

        if (a.fromRosterId) from.add(a.fromRosterId);
        if (a.toRosterId) to.add(a.toRosterId);
      }
    }

    const fromLabel = from.size ? rosterLabel([...from][0]) : "—";
    const toLabel = to.size ? rosterLabel([...to][0]) : "—";

    // TRADE (different teams)
    if (from.size && to.size && fromLabel !== toLabel) {
      return `${fromLabel} ↔ ${toLabel}`;
    }

    // ADD/DROP SAME TEAM
    if (adds.length || drops.length) {
      const team = fromLabel !== "—" ? fromLabel : toLabel;

      return (
        <div>
          <div className="font-semibold">{team}</div>
          {adds.length > 0 && (
            <div className="text-emerald-600">Added: {adds.join(", ")}</div>
          )}
          {drops.length > 0 && (
            <div className="text-rose-600">Dropped: {drops.join(", ")}</div>
          )}
        </div>
      );
    }

    return "—";
  }

  /* --------------------------------------- */

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-bold mb-6">Transactions</h1>

      <div className="rounded-xl border overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50">
            <tr>
              <th className="p-3 text-left">Season</th>
              <th className="p-3 text-left">Week</th>
              <th className="p-3 text-left">Date</th>
              <th className="p-3 text-left">Type</th>
              <th className="p-3 text-left">Teams / Moves</th>
            </tr>
          </thead>

          <tbody>
            {transactions.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="p-3">{t.season}</td>
                <td className="p-3">{t.week}</td>
                <td className="p-3">
                  {new Date(t.createdAt).toLocaleDateString()}
                </td>
                <td className="p-3 capitalize">{t.type}</td>
                <td className="p-3">{summarizeTransaction(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
