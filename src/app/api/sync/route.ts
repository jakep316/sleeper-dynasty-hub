import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague, getUsers, getRosters, getMatchups, getTransactions } from "@/lib/sleeper";

/*
  Syncs ONE Sleeper league id (one season).
  Safe to run repeatedly (upserts + deletes/recreates assets per txn).
*/

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const leagueId = searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID!;
    if (!leagueId) throw new Error("Missing leagueId");

    const league = await getLeague(leagueId);
    const season = Number((league as any).season);

    // ---------------- USERS ----------------
    const users = await getUsers(leagueId);
    for (const u of users as any[]) {
      await db.sleeperUser.upsert({
        where: { sleeperUserId: u.user_id },
        update: { displayName: u.display_name, username: u.username },
        create: { sleeperUserId: u.user_id, displayName: u.display_name, username: u.username },
      });
    }

    // ---------------- ROSTERS ----------------
    const rosters = await getRosters(leagueId);
    for (const r of rosters as any[]) {
      await db.roster.upsert({
        where: {
          leagueId_season_rosterId: {
            leagueId,
            season,
            rosterId: r.roster_id,
          },
        },
        update: { ownerId: r.owner_id },
        create: {
          leagueId,
          season,
          rosterId: r.roster_id,
          ownerId: r.owner_id,
        },
      });
    }

    // ---------------- MATCHUPS ----------------
    let matchupsUpserted = 0;
    for (let week = 1; week <= 18; week++) {
      const matchups = await getMatchups(leagueId, week);
      if (!matchups?.length) continue;

      for (const m of matchups as any[]) {
        await db.matchup.upsert({
          where: {
            leagueId_season_week_rosterId: {
              leagueId,
              season,
              week,
              rosterId: m.roster_id,
            },
          },
          update: { points: m.points },
          create: {
            leagueId,
            season,
            week,
            rosterId: m.roster_id,
            points: m.points,
          },
        });
        matchupsUpserted++;
      }
    }

    // ---------------- TRANSACTIONS ----------------
    let transactionsFetched = 0;
    let transactionsUpserted = 0;
    let assetsCreated = 0;

    for (let week = 0; week <= 18; week++) {
      const txns = await getTransactions(leagueId, week);
      if (!txns?.length) continue;

      transactionsFetched += txns.length;

      for (const t of txns as any[]) {
        await db.transaction.upsert({
          where: { id: t.transaction_id },
          update: {
            leagueId,
            season,
            week,
            type: t.type,
            status: t.status,
            createdAt: new Date(t.created),
            rawJson: t,
          },
          create: {
            id: t.transaction_id,
            leagueId,
            season,
            week,
            type: t.type,
            status: t.status,
            createdAt: new Date(t.created),
            rawJson: t, // required by your schema
          },
        });

        transactionsUpserted++;

        // delete old assets for this transaction (so re-sync is clean)
        await db.transactionAsset.deleteMany({
          where: { transactionId: t.transaction_id },
        });

        const movements = buildMovements(t);

        for (const mv of movements) {
          await db.transactionAsset.create({
            data: {
              transactionId: t.transaction_id,
              ...mv,
            },
          });
          assetsCreated++;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      leagueId,
      season,
      users: (users as any[]).length,
      rosters: (rosters as any[]).length,
      matchupsUpserted,
      transactionsFetched,
      transactionsUpserted,
      assetsCreated,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}

/**
 * Build TransactionAsset rows from a Sleeper txn.
 * - Players: from adds/drops pairing (so trades have both sides)
 * - Picks: from draft_picks
 * - FAAB: from waiver_budget if present
 */
function buildMovements(t: any) {
  const adds: Record<string, number> = t.adds ?? {};
  const drops: Record<string, number> = t.drops ?? {};
  const draftPicks: any[] = Array.isArray(t.draft_picks) ? t.draft_picks : [];
  const waiverBudget: any[] = Array.isArray(t.waiver_budget) ? t.waiver_budget : [];

  const movements: any[] = [];

  // Pair adds/drops by asset id (players primarily)
  const allIds = new Set<string>([...Object.keys(adds), ...Object.keys(drops)]);
  for (const id of allIds) {
    movements.push({
      kind: "player",
      playerId: id,
      fromRosterId: typeof drops[id] === "number" ? drops[id] : null,
      toRosterId: typeof adds[id] === "number" ? adds[id] : null,
    });
  }

  // Picks (draft_picks)
  for (const p of draftPicks) {
    const pickSeason = Number(p.season);
    const pickRound = Number(p.round);

    const toRosterId =
      typeof p.owner_id === "number"
        ? p.owner_id
        : typeof p.roster_id === "number"
          ? p.roster_id
          : null;

    const fromRosterId =
      typeof p.previous_owner_id === "number"
        ? p.previous_owner_id
        : typeof p.previous_owner_roster_id === "number"
          ? p.previous_owner_roster_id
          : null;

    movements.push({
      kind: "pick",
      pickSeason: Number.isFinite(pickSeason) ? pickSeason : null,
      pickRound: Number.isFinite(pickRound) ? pickRound : null,
      fromRosterId,
      toRosterId,
    });
  }

  // FAAB (optional)
  for (const b of waiverBudget) {
    if (
      typeof b?.from === "number" &&
      typeof b?.to === "number" &&
      typeof b?.amount === "number"
    ) {
      movements.push({
        kind: "faab",
        faabAmount: b.amount,
        fromRosterId: b.from,
        toRosterId: b.to,
      });
    }
  }

  return movements;
}
