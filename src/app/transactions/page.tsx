import { db } from "@/lib/db";

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

  const txs = await db.transaction.findMany({
    where: { leagueId, season: seasonRow.season },
    orderBy: [{ week: "desc" }, { createdAt: "desc" }],
    take: 100,
  });

  return (
    <div style={{ padding: 24 }}>
      <h1>Transactions</h1>
      <p>Latest 100</p>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        {txs.map((t) => (
          <div
            key={t.id}
            style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}
          >
            <div style={{ fontWeight: 700 }}>
              Week {t.week} • {t.type} • {t.status}
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{t.id}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
