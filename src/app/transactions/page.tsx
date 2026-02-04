import { db } from "@/lib/db";
import { getRosterNameMap } from "@/lib/names";

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs font-semibold text-zinc-700">
      {children}
    </span>
  );
}

export default async function TransactionsPage() {
  const leagueId = process.env.SLEEPER_LEAGUE_ID!;
  const seasonRow = await db.leagueSeason.findFirst({
    where: { leagueId },
    orderBy: { season: "desc" },
  });

  if (!seasonRow) {
    return (
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
        <p className="mt-2 text-sm text-zinc-600">No data yet. Run sync: POST /api/sync</p>
      </div>
    );
  }

  const season = seasonRow.season;
  const rosterNames = await getRosterNameMap(leagueId, season);
  const nameOf = (id: number | null) => (id == null ? "—" : rosterNames.get(id) ?? `Roster ${id}`);

  const txs = await db.transaction.findMany({
    where: { leagueId, season },
    orderBy: [{ week: "desc" }, { createdAt: "desc" }],
    take: 50,
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
    <div className="grid gap-4">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Season {season} • Latest {txs.length}
        </p>
      </div>

      <div className="grid gap-3">
        {txs.map((t) => {
          const a = assetsByTx.get(t.id) ?? [];
          return (
            <div key={t.id} className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold">
                    Week {t.week} <span className="text-zinc-300">•</span> {t.type}
                  </div>
                  <Badge>{t.status}</Badge>
                </div>
                <div className="text-xs text-zinc-500">{t.id}</div>
              </div>

              {a.length > 0 ? (
                <div className="mt-3 grid gap-2">
                  {a.slice(0, 10).map((x, i) => {
                    const label =
                      x.kind === "pick"
                        ? `Pick ${x.pickSeason ?? "?"} R${x.pickRound ?? "?"}`
                        : x.kind === "faab"
                        ? `FAAB $${x.faabAmount ?? 0}`
                        : x.kind === "player" || x.kind === "player_drop"
                        ? `Player ${x.playerId ?? ""}` // next step: real player names
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
                  {a.length > 10 && <div className="text-xs text-zinc-500">…and {a.length - 10} more</div>}
                </div>
              ) : (
                <div className="mt-3 text-sm text-zinc-500">No asset details stored for this transaction.</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
