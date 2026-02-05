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
  const leagueId = process.env.SLEEPER_LEAGUE_ID!;
  if (!leagueId) {
    return (
      <main className="mx-auto max-w-6xl p-6">
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-rose-900">
          Missing <code className="font-mono">SLEEPER_LEAGUE_ID</code> env var.
        </div>
      </main>
    );
  }

  // seasons + types for UI (safe defaults even if DB empty)
  const [seasonRows, typeRows] = await Promise.all([
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

  const seasons = (seasonRows ?? []).map((r) => ({
    value: String(r.season),
    label: String(r.season),
  }));

  const types = (typeRows ?? [])
    .map((r) => r.type)
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .sort()
    .map((t) => ({ value: t, label: prettyType(t) }));

  // Build team dropdown for latest season we have (or current year fallback)
  const latestSeason = seasonRows?.[0]?.season ?? new Date().getFullYear();

  const rosterRows = await db.roster.findMany({
    where: { leagueId, season: latestSeason },
    select: { rosterId: true, ownerId: true },
    orderBy: { rosterId: "asc" },
  });

  const ownerIds = Array.from(
    new Set(rosterRows.map((r) => r.ownerId).filter((x): x is string => !!x))
  );

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

  const teams = (rosterRows ?? []).map((r) => ({
    value: String(r.rosterId),
    label: (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`,
  }));

  return (
    <TransactionsClient
      leagueId={leagueId}
      seasons={seasons}
      types={types}
      teams={teams}
    />
  );
}
