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
  const leagueId = process.env.SLEEPER_LEAGUE_ID!;

  const seasonParam = searchParams?.season ?? "all";
  const teamParam = searchParams?.team ?? "all";
  const typeParam = searchParams?.type ?? "all";
  const page = Number(searchParams?.page ?? 1);

  /*
    ---------------------------------------
    Filters
    ---------------------------------------
  */

  const where: any = { leagueId };

  if (seasonParam !== "all") where.season = Number(seasonParam);
  if (typeParam !== "all") where.type = typeParam;

  /*
    ---------------------------------------
    Fetch transactions
    ---------------------------------------
  */

  const [transactions, totalCount] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        assets: true,
      },
    }),
    db.transaction.count({ where }),
  ]);

  /*
    ---------------------------------------
    Player name lookup
    ---------------------------------------
  */

  const playerIds = Array.from(
    new Set(
      transactions
        .flatMap((t) => t.assets)
        .map((a) => a.playerId)
        .filter(Boolean)
    )
  ) as string[];

  const players = await db.sleeperPlayer.findMany({
    where: { id: { in: playerIds } },
  });

  const playerMap = new Map(players.map((p) => [p.id, p]));

  /*
    ---------------------------------------
    Seasons + types for filters
    ---------------------------------------
  */

  const [seasons, types] = await Promise.all([
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

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  /*
    ---------------------------------------
    Helpers
    ---------------------------------------
  */

  function renderAsset(a: any) {
    if (a.kind === "player" || a.kind === "player_drop") {
      const p = playerMap.get(a.playerId);
      const name = p?.fullName ?? `Player ${a.playerId}`;
      const pos = p?.position ?? "";
      const team = p?.team ?? "";

      return `${name} ${pos ? `(${pos}${team ? ", " + team : ""})` : ""}`;
    }

    if (a.kind === "pick") {
      return `${a.pickSeason} Round ${a.pickRound}`;
    }

    if (a.kind === "faab") {
      return `FAAB $${a.faabAmount}`;
    }

    return a.kind;
  }

  /*
    ---------------------------------------
    Render
    ---------------------------------------
  */

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Transactions</h1>

      <FiltersClient
        seasonParam={seasonParam}
        teamParam={teamParam}
        typeParam={typeParam}
        seasons={seasons.map((s) => s.season)}
        types={(types.map((t) => t.type).filter(Boolean) as string[])}
      />

      <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-600">
            <tr>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">Type</th>
              <th className="text-left p-3">Assets</th>
            </tr>
          </thead>

          <tbody>
            {transactions.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="p-3 whitespace-nowrap">
                  {new Date(t.createdAt).toLocaleDateString()}
                </td>

                <td className="p-3 capitalize">{t.type}</td>

                <td className="p-3">
                  <ul className="space-y-1">
                    {t.assets.map((a: any, i: number) => (
                      <li key={i}>{renderAsset(a)}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex justify-between items-center text-sm text-zinc-600">
        <span>
          Page {page} of {totalPages}
        </span>

        <div className="flex gap-3">
          {page > 1 && (
            <a
              href={`/transactions?page=${page - 1}`}
              className="underline"
            >
              ← Prev
            </a>
          )}

          {page < totalPages && (
            <a
              href={`/transactions?page=${page + 1}`}
              className="underline"
            >
              Next →
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
