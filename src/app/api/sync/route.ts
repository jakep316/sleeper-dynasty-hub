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
  This route syncs ONE league id.

  Supports:
  POST /api/sync
  POST /api/sync?leagueId=123

  The sync-history route will call this multiple times for each previous league id.
*/

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);

    // Allow override via query param
    const leagueId =
      url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID!;

    if (!leagueId) {
      return NextResponse.json(
        { ok: false, error: "Missing leagueId" },
        { status: 400 }
      );
    }

    console.log("Syncing league:", leagueId);

    /*
      -----------------------------------
      League metadata
      -----------------------------------
    */

    const league = await getLeague(leagueId);

    const season = Number(league.season);
    const totalWeeks = Number(league.settings?.playoff_week_start ?? 17);

    await db.leagueSeason.upsert({
      where: {
        leagueId_season: {
          leagueId,
          season,
        },
      },
      update: {},
      create: {
        leagueId,
        season,
      },
    });

    /*
      -----------------------------------
      Users
      -----------------------------------
    */

    const users = await getLeagueUsers(leagueId);

    for (const u of users) {
      await db.sleeperUser.upsert({
        where: { sleeperUserId: u.user_id },
        update: {
          displayName: u.display_name ?? null,
          username: u.username ?? null,
        },
        create: {
          sleeperUserId: u.user_id,
          displayName: u.display_name ?? null,
          username: u.username ?? null,
        },
      });
    }

    /*
      -----------------------------------
      Rosters
      -----------------------------------
    */

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
          ownerId: r.owner_id ?? null,
        },
        create: {
          leagueId,
          season,
          rosterId: r.roster_id,
          ownerId: r.owner_id ?? null,
        },
      });
    }

    /*
      -----------------------------------
      Matchups + Transactions (per week)
      -----------------------------------
    */

    let matchupCount = 0;
    let txCount = 0;
    let assetCount = 0;

    for (let week = 1; week <= totalWeeks; week++) {
      /*
        ---------- Matchups ----------
      */
      const matchups = await getMatchupsForWeek(leagueId, week);

      for (const m of matchups) {
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
            matchupId: m.matchup_id ?? null,
            points: m.points ?? 0,
          },
          create: {
            leagueId,
            season,
            week,
            rosterId: m.roster_id,
            matchupId: m.matchup_id ?? null,
            points: m.points ?? 0,
          },
        });

        matchupCount++;
      }

      /*
        ---------- Transactions ----------
      */
      const txs = await getTransactionsForWeek(leagueId, week);

      for (const t of txs) {
        await db.transaction.upsert({
          where: { id: t.transaction_id },
          update: {
            leagueId,
            season,
            week,
            type: t.type,
            status: t.status,
            createdAt: new Date(t.created),
          },
          create: {
            id: t.transaction_id,
            leagueId,
            season,
            week,
            type: t.type,
            status: t.status,
            createdAt: new Date(t.created),
          },
        });

        txCount++;

        /*
          ----- Assets -----
        */

        // clear old assets first (safe for re-sync)
        await db.transactionAsset.deleteMany({
          where: { transactionId: t.transaction_id },
        });

        const adds = t.adds ?? {};
        const drops = t.drops ?? {};

        // players added
        for (const [playerId, rosterId] of Object.entries(adds)) {
          await db.transactionAsset.create({
            data: {
              transactionId: t.transaction_id,
              kind: "player",
              playerId,
              fromRosterId: null,
              toRosterId: Number(rosterId),
            },
          });
          assetCount++;
        }

        // players dropped
        for (const [playerId, rosterId] of Object.entries(drops)) {
          await db.transactionAsset.create({
            data: {
              transactionId: t.transaction_id,
              kind: "player_drop",
              playerId,
              fromRosterId: Number(rosterId),
              toRosterId: null,
            },
          });
          assetCount++;
        }

        // picks
        for (const p of t.draft_picks ?? []) {
          await db.transactionAsset.create({
            data: {
              transactionId: t.transaction_id,
              kind: "pick",
              fromRosterId: p.previous_owner_id ?? null,
              toRosterId: p.owner_id ?? null,
              pickSeason: p.season,
              pickRound: p.round,
            },
          });
          assetCount++;
        }

        // FAAB
        if (t.settings?.waiver_budget) {
          await db.transactionAsset.create({
            data: {
              transactionId: t.transaction_id,
              kind: "faab",
              faabAmount: t.settings.waiver_budget,
              fromRosterId: null,
              toRosterId: null,
            },
          });
          assetCount++;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      leagueId,
      season,
      matchups: matchupCount,
      transactions: txCount,
      assets: assetCount,
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
