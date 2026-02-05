import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getLeague,
  getLeagueUsers,
  getLeagueRosters,
  getMatchupsForWeek,
  getTransactionsForWeek,
} from "@/lib/sleeper";

/*
  Syncs ONE Sleeper leagueId + season into DB
  Safe to run repeatedly (upserts + deletes assets per txn)
*/

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const leagueId =
      searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID!;

    const league = await getLeague(leagueId);
    const season = Number(league.season);

    /* -------------------------------------------
       USERS
    --------------------------------------------*/

    const users = await getLeagueUsers(leagueId);

    for (const u of users) {
      await db.sleeperUser.upsert({
        where: { sleeperUserId: u.user_id },
        update: {
          displayName: u.display_name,
          username: u.username,
        },
        create: {
          sleeperUserId: u.user_id,
          displayName: u.display_name,
          username: u.username,
        },
      });
    }

    /* -------------------------------------------
       ROSTERS
    --------------------------------------------*/

    const rosters = await getLeagueRosters(leagueId);

    for (const r of rosters) {
      await db.roster.upsert({
        where: {
          leagueId_season_rosterId: {
            leagueId,
            season,
            rosterId: r.roster_id,
          },
        },
        update: {
          ownerId: r.owner_id,
        },
        create: {
          leagueId,
          season,
          rosterId: r.roster_id,
          ownerId: r.owner_id,
        },
      });
    }

    /* -------------------------------------------
       MATCHUPS
    --------------------------------------------*/

    let matchupCount = 0;

    for (let week = 1; week <= 18; week++) {
      const matchups = await getMatchupsForWeek(leagueId, week);
      if (!matchups?.length) continue;

      for (const m of matchups) {
        matchupCount++;

        await db.matchup.upsert({
          where: {
            leagueId_season_week_rosterId: {
              leagueId,
              season,
              week,
              rosterId: m.roster_id,
            },
          },
          update: {
            points: m.points,
          },
          create: {
            leagueId,
            season,
            week,
            rosterId: m.roster_id,
            points: m.points,
          },
        });
      }
    }

    /* -------------------------------------------
       TRANSACTIONS
    --------------------------------------------*/

    let transactionsFetched = 0;
    let transactionsUpserted = 0;
    let assetsCreated = 0;

    for (let week = 0; week <= 18; week++) {
      const txns = await getTransactionsForWeek(leagueId, week);
      if (!txns?.length) continue;

      transactionsFetched += txns.length;

      for (const t of txns) {
        // upsert transaction
        await db.transaction.upsert({
          where: { id: t.transaction_id },
          update: {},
          create: {
            id: t.transaction_id,
            leagueId,
            season,
            week,
            type: t.type,
            status: t.status,
            createdAt: new Date(t.created),
            rawJson: t,
          },
        });

        transactionsUpserted++;

        // DELETE old assets first (safe re-sync)
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
      users: users.length,
      rosters: rosters.length,
      matchups: matchupCount,
      transactionsFetched,
      transactionsUpserted,
      assetsCreated,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "sync failed" },
      { status: 500 }
    );
  }
}

/* ===========================================================
   MOVEMENT BUILDER (FIXES YOUR TRADE BUG)
   =========================================================== */

function buildMovements(t: any) {
  const adds = t.adds ?? {};
  const drops = t.drops ?? {};
  const draftPicks = Array.isArray(t.draft_picks) ? t.draft_picks : [];

  const movements: any[] = [];

  /* ---------- players / adds-drops pairing ---------- */

  const allIds = new Set([
    ...Object.keys(adds),
    ...Object.keys(drops),
  ]);

  for (const id of allIds) {
    movements.push({
      kind: "player",
      playerId: id,
      fromRosterId: drops[id] ?? null,
      toRosterId: adds[id] ?? null,
    });
  }

  /* ---------- picks ---------- */

  for (const p of draftPicks) {
    movements.push({
      kind: "pick",
      pickSeason: Number(p.season),
      pickRound: Number(p.round),
      fromRosterId: p.previous_owner_id ?? null,
      toRosterId: p.owner_id ?? null,
    });
  }

  return movements;
}
