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

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
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

  // Starter lists (real results are pulled from /api/transactions).
  // We'll still populate checkboxes with real values from DB to avoid "Roster 1".
  const seasonRows = await db.transaction.findMany({
    distinct: ["season"],
    select: { season: true },
    orderBy: { season: "desc" },
  });

  const typeRows = await db.transaction.findMany({
    distinct: ["type"],
    select: { type: true },
  });

  const latestSeason = seasonRows[0]?.season ?? new Date().getFullYear();

  // Pull rosters for the latest season for THIS root league id
  const rosters = await db.roster.findMany({
    where: { leagueId: rootLeagueId, season: latestSeason },
    select: { rosterId: true, ownerId: true },
    orderBy: { rosterId: "asc" },
  });

  const ownerIds = uniq(rosters.map((r) => r.ownerId).filter((x): x is string => !!x));

  const owners =
    ownerIds.length > 0
      ? await db.sleeperUser.findMany({
          where: { sleeperUserId: { in: ownerIds } },
          select: { sleeperUserId: true, displayName: true, username: true },
        })
      : [];

  const ownerMap = new Map(
    owners.map((o) => [o.sleeperUserId, o.displayName ?? o.username ?? o.sleeperUserId])
  );

  const seasons: Option[] = seasonRows.map((s) => ({
    value: String(s.season),
    label: String(s.season),
  }));

  const types: Option[] = (typeRows.map((t) => t.type).filter(Boolean) as string[])
    .sort()
    .map((t) => ({ value: t, label: prettyType(t) }));

  // Teams: use owner label if available, fall back to roster id
  const teams: Option[] =
    rosters.length > 0
      ? rosters.map((r) => ({
          value: String(r.rosterId),
          label: (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`,
        }))
      : Array.from({ length: 20 }, (_, i) => ({
          value: String(i + 1),
          label: `Roster ${i + 1}`,
        }));

  return (
    <TransactionsClient
      rootLeagueId={rootLeagueId}
      seasons={seasons}
      types={types}
      teams={teams}
    />
  );
}
