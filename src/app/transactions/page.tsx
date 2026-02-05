import TransactionsClient from "./TransactionsClient";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Option = { value: string; label: string };

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default async function TransactionsPage() {
  const rootLeagueId = process.env.SLEEPER_LEAGUE_ID!;
  if (!rootLeagueId) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
          Missing <code className="font-mono">SLEEPER_LEAGUE_ID</code> env var.
        </div>
      </main>
    );
  }

  // These dropdown options are "starter lists".
  // The real results come from /api/transactions using the league chain.
  const seasonRows = await db.transaction.findMany({
    distinct: ["season"],
    select: { season: true },
    orderBy: { season: "desc" },
  });

  const typeRows = await db.transaction.findMany({
    distinct: ["type"],
    select: { type: true },
  });

  // Team options: use current season rosters if available; fallback to roster 1-20
  const latestSeason = seasonRows[0]?.season ?? new Date().getFullYear();

  const rosterRows = await db.roster.findMany({
    where: { leagueId: rootLeagueId, season: latestSeason },
    select: { rosterId: true },
    orderBy: { rosterId: "asc" },
  });

  const seasons: Option[] = seasonRows.map((s) => ({ value: String(s.season), label: String(s.season) }));

  const types: Option[] = (typeRows.map((t) => t.type).filter(Boolean) as string[])
    .sort()
    .map((t) => ({ value: t, label: prettyType(t) }));

  const teams: Option[] =
    rosterRows.length > 0
      ? rosterRows.map((r) => ({ value: String(r.rosterId), label: `Roster ${r.rosterId}` }))
      : Array.from({ length: 20 }, (_, i) => ({ value: String(i + 1), label: `Roster ${i + 1}` }));

  return <TransactionsClient rootLeagueId={rootLeagueId} seasons={seasons} types={types} teams={teams} />;
}
