import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague, getUsers, getRosters, getMatchups, getTransactions } from "@/lib/sleeper";

/*
  Syncs ONE Sleeper league id.

  POST /api/sync
  POST /api/sync?leagueId=123

  Used by /api/sync-history to sync the previous_league_id chain.
*/

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);

    const leagueId = url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID!;
    if (!leagueId) {
      return NextResponse.json({ ok: false, error: "Missing leagueId" }, { status: 400 });
    }

    const league = await getLeague(leagueId);

    // Sleeper returns season as string
    const season = Number(league.season);

    // ✅ IMPORTANT: transactions often live in week 0 (offseason)
    // and regular season can go to week 18.
    // We'll just sync 0..18 consistently across leagues.
    const MIN_WEEK = 0;
    const MAX_WEEK = 18;

    await db.leagueSeason.upsert({
      where: { leagueId_season: { leagueId, season } },
      update: {},
      create: { leagueId, season },
    });

    // USERS
    const users = await getUsers(leagueId);
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

    // ROSTERS
    const rosters = await getRosters(leagueId);
    for (const r of rosters) {
      await db.roster.upsert({
        where: { leagueId_season_rosterId: { leagueId, season, rosterId: r.roster_id } },
        update: { ownerId: r.owner_id ?? null },
        create: { leagueId, season, rosterId: r.roster_id, ownerId: r.owner_id ?? null },
      });
    }

    let matchupCount = 0;
    let txCount = 0;
    let assetCount = 0;
    let weeksTouched = 0;

    for (let week = MIN_WEEK; week <= MAX_WEEK; week++) {
      weeksTouched++;

      // Matchups only really exist in regular season weeks, but harmless if empty
      const matchups = await getMatchups(leagueId, week);
      for (const m of matchups) {
        await db.matchup.upsert({
          where: { leagueId_season_week_rosterId: { leagueId, season, week, rosterId: m.roster_id } },
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

      // Transactions (this is what we care about)
      const txs = await getTransactions(leagueId, week);

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
            rawJson: t as any, // required by your schema
          },
          create: {
            id: t.transaction_id,
            leagueId,
            season,
            week,
            type: t.type,
            status: t.status,
            createdAt: new Date(t.created),
            rawJson: t as any, // required by your schema
          },
        });
        txCount++;

        // Make resync deterministic
        await db.transactionAsset.deleteMany({ where: { transactionId: t.transaction_id } });

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

        // picks moved
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

        // Optional: capture waiver_budget value if present
        if (t.settings?.waiver_budget !== undefined && t.settings?.waiver_budget !== null) {
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
      weeksSynced: weeksTouched,
      users: users.length,
      rosters: rosters.length,
      matchups: matchupCount,
      transactions: txCount,
      assets: assetCount,
    });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
