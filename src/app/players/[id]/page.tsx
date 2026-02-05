import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

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

type Props = { params: { id: string } };

export default async function PlayerPage({ params }: Props) {
  const id = params.id;

  const player = await db.sleeperPlayer.findUnique({
    where: { id },
    select: { id: true, fullName: true, position: true, team: true, status: true },
  });

  if (!player) {
    return (
      <main className="mx-auto max-w-6xl p-6">
        <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold">Player not found</h1>
          <p className="mt-2 text-sm text-zinc-600">{id}</p>
        </div>
      </main>
    );
  }

  // Pull transaction assets that reference this player, include the parent transaction
  const assets = await db.transactionAsset.findMany({
    where: { playerId: id },
    include: { transaction: true },
    orderBy: [{ transaction: { season: "desc" } }, { transaction: { week: "desc" } }, { transaction: { createdAt: "desc" } }],
    take: 500,
  });

  const txs = assets.map((a) => a.transaction);

  // Build roster -> owner label map for the league/season combos present
  const leagueSeasonPairs = Array.from(new Set(txs.map((t) => `${t.leagueId}::${t.season}`))).map((k) => {
    const [leagueId, s] = k.split("::");
    return { leagueId, season: Number(s) };
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

  const ownerMap = new Map(owners.map((o) => [o.sleeperUserId, o.displayName ?? o.username ?? o.sleeperUserId]));

  const rosterLabelMap = new Map<string, string>();
  for (const r of rosterRows) {
    const label = (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`;
    rosterLabelMap.set(`${r.leagueId}::${r.season}::${r.rosterId}`, label);
  }

  const rosterLabel = (leagueId: string, season: number, rosterId: number | null | undefined) => {
    if (rosterId === null || rosterId === undefined) return "—";
    return rosterLabelMap.get(`${leagueId}::${season}::${rosterId}`) ?? `Roster ${rosterId}`;
  };

  // Render a simple "direction" per asset row
  const rows = assets.map((a) => {
    const t = a.transaction;
    const from = rosterLabel(t.leagueId, t.season, a.fromRosterId);
    const to = rosterLabel(t.leagueId, t.season, a.toRosterId);

    let action = "—";
    if (a.fromRosterId && !a.toRosterId) action = `Dropped by ${from}`;
    else if (!a.fromRosterId && a.toRosterId) action = `Added by ${to}`;
    else if (a.fromRosterId && a.toRosterId && a.fromRosterId !== a.toRosterId) action = `${from} → ${to}`;

    return {
      txId: t.id,
      season: t.season,
      week: t.week,
      type: t.type,
      date: t.createdAt,
      action,
    };
  });

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-zinc-500">
          <a href="/players" className="hover:underline">← Back to search</a>
        </div>

        <h1 className="mt-2 text-2xl font-bold">
          {player.fullName ?? player.id}
        </h1>

        <div className="mt-2 text-sm text-zinc-700">
          {[player.position, player.team].filter(Boolean).join(" • ") || "—"}{" "}
          {player.status ? <span className="text-zinc-500">• {player.status}</span> : null}
        </div>
      </div>

      <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
        <div className="p-4 border-b border-zinc-200 text-sm text-zinc-600">
          Showing <span className="font-semibold text-zinc-900">{rows.length}</span> transaction appearances (max 500).
        </div>

        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-600">
            <tr>
              <th className="text-left p-3">Season</th>
              <th className="text-left p-3">Week</th>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">Type</th>
              <th className="text-left p-3">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={`${r.txId}-${idx}`} className="border-t align-top">
                <td className="p-3 whitespace-nowrap">{r.season}</td>
                <td className="p-3 whitespace-nowrap">{r.week}</td>
                <td className="p-3 whitespace-nowrap">{new Date(r.date).toLocaleDateString()}</td>
                <td className="p-3 whitespace-nowrap">{prettyType(r.type)}</td>
                <td className="p-3">{r.action}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="p-6 text-zinc-600" colSpan={5}>
                  No transactions found for this player yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
