import { db } from "@/lib/db";

/**
 * rosterId -> manager display name
 */
export async function getRosterNameMap(leagueId: string, season: number) {
  const rosters = await db.roster.findMany({
    where: { leagueId, season },
    select: { rosterId: true, ownerId: true },
  });

  const ownerIds = rosters
    .map((r) => r.ownerId)
    .filter((x): x is string => typeof x === "string" && x.length > 0);

  const users =
    ownerIds.length > 0
      ? await db.sleeperUser.findMany({
          where: { sleeperUserId: { in: ownerIds } },
          select: { sleeperUserId: true, displayName: true, username: true },
        })
      : [];

  const userMap = new Map<string, string>();
  for (const u of users) {
    userMap.set(u.sleeperUserId, u.displayName ?? u.username ?? u.sleeperUserId);
  }

  const rosterMap = new Map<number, string>();
  for (const r of rosters) {
    const name = r.ownerId ? userMap.get(r.ownerId) : null;
    rosterMap.set(r.rosterId, name ?? `Roster ${r.rosterId}`);
  }

  return rosterMap;
}
