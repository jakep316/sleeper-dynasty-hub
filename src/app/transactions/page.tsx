import { db } from "@/lib/db";
import { getRosterNameMap } from "@/lib/names";

export default async function TransactionsPage() {
  const leagueId = process.env.SLEEPER_LEAGUE_ID!;
  const seasonRow = await db.leagueSeason.findFirst({
    where: { leagueId },
    orderBy: { season: "desc" },
  });

  if (!seasonRow) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Transactions</h1>
        <p>No data yet. Run sync: POST /api/sync</p>
      </div>
    );
  }

  const season = seasonRow.season;

  const rosterNames = await getRosterNameMap(leagueId, season);
  const nameOf = (rosterId: number | null) =>
    rosterId == null ? "—" : rosterNames.get(rosterId) ?? `Roster ${rosterId}`;

  const txs = await db.transaction.findMany({
    where: { leagueId, season },
    orderBy: [{ week: "desc" }, { createdAt: "desc" }],
    take: 100,
  });

  const txIds = txs.map((t) => t.id);

  const assets = txIds.length
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

  return (
    <div style={{ padding: 24 }}>
      <h1>Transactions</h1>
      <p>Season {season} • Latest 100</p>

      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        {txs.map((t) => {
          const a = assetsByTx.get(t.id) ?? [];
          return (
            <div key={t.id} style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700 }}>
                  Week {t.week} • {t.type} • {t.status}
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{t.id}</div>
              </div>

              {a.length > 0 && (
                <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                  {a.slice(0, 12).map((x, i) => {
                    const label =
                      x.kind === "pick"
                        ? `Pick ${x.pickSeason ?? "?"} R${x.pickRound ?? "?"}`
                        : x.kind === "faab"
                        ? `FAAB $${x.faabAmount ?? 0}`
                        : x.kind === "player" || x.kind === "player_drop"
                        ? `Player ${x.playerId ?? ""}`
                        : x.kind;

                    return (
                      <div key={`${t.id}-${i}`} style={{ fontSize: 13, opacity: 0.95 }}>
                        {label} — {nameOf(x.fromRosterId)} → {nameOf(x.toRosterId)}
                      </div>
                    );
                  })}

                  {a.length > 12 && (
                    <div style={{ fontSize: 13, opacity: 0.7 }}>…and {a.length - 12} more</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
