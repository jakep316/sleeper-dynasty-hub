import { db } from "@/lib/db";
import TransactionsClient from "./TransactionsClient";

export const dynamic = "force-dynamic";

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default async function TransactionsPage() {
  const rootLeagueId = process.env.SLEEPER_LEAGUE_ID!;
  if (!rootLeagueId) throw new Error("Missing SLEEPER_LEAGUE_ID env var");

  // Seasons + types from whatever is already in DB (across all chain IDs will be handled in API)
  const [seasonRows, typeRows] = await Promise.all([
    db.transaction.findMany({
      distinct: ["season"],
      select: { season: true },
      orderBy: { season: "desc" },
    }),
    db.transaction.findMany({
      distinct: ["type"],
      select: { type: true },
    }),
  ]);

  const seasons = seasonRows.map((s) => ({
    value: String(s.season),
    label: String(s.season),
  }));

  const types = typeRows
    .map((t) => t.type)
    .filter((x): x is string => !!x)
    .sort()
    .map((t) => ({ value: t, label: prettyType(t) }));

  // Teams: use the most recent season we have rosters for the root league (fallback safe)
  const newestSeason = seasonRows[0]?.season ?? new Date().getFullYear();

  const rosters = await db.roster.findMany({
    where: { leagueId: rootLeagueId, season: newestSeason },
    select: { rosterId: true, ownerId: true },
    orderBy: { rosterId: "asc" },
  });

  const ownerIds = Array.from(new Set(rosters.map((r) => r.ownerId).filter(Boolean))) as string[];
  const owners =
    ownerIds.length > 0
      ? await db.sleeperUser.findMany({
          where: { sleeperUserId: { in: ownerIds } },
          select: { sleeperUserId: true, displayName: true, username: true },
        })
      : [];

  const ownerMap = new Map(owners.map((o) => [o.sleeperUserId, o.displayName ?? o.username]));

  const teams = rosters.map((r) => ({
    value: String(r.rosterId),
    label: (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`,
  }));

  return <TransactionsClient rootLeagueId={rootLeagueId} seasons={seasons} types={types} teams={teams} />;
}
