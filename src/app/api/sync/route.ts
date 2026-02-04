import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getLeague, getUsers, getRosters, getMatchups, getTransactions } from "@/lib/sleeper";

export const dynamic = "force-dynamic";

/**
 * POST /api/sync
 * POST /api/sync?leagueId=123
 *
 * Syncs ONE league:
 * - users, rosters
 * - matchups weeks 1..18
 * - transactions weeks 0..18
 */
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const leagueId = url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID!;
    if (!leagueId) return NextResponse.json({ ok: false, error: "Missing leagueId" }, { status: 400 });

    const league = await getLeague(leagueId);
    const season = Number(league.season);

    await db.leagueSeason.upsert({
      where: { leagueId_season: { leagueId, season } },
      update: {},
      create: { leagueId, season },
    });

    // USERS (for THIS leagueId)
    const users = await getUsers(leagueId);
    await Promise.all(
      users.map((u) =>
        db.sleeperUser.upsert({
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
        })
      )
    );

    // ROSTERS (for THIS leagueId + season)
    const rosters = await getRosters(leagueId);
    await Promise.all(
      rosters.map((r) =>
        db.roster.upsert({
          where: { leagueId_season_rosterId: { leagueId, season, rosterId: r.roster_id } },
          update: { ownerId: r.owner_id ?? null },
          create: { leagueId, season, rosterId: r.roster_id, ownerId: r.owner_id ?? null },
        })
      )
    );

    // MATCHUPS (weeks 1..18)
    let matchupCount = 0;
    for (let week = 1; week <= 18; week++) {
      const matchups = await getMatchups(leagueId, week);
      matchupCount += matchups.length;

      await Promise.all(
        matchups.map((m) =>
          db.matchup.upsert({
            where: { leagueId_season_week_rosterId: { leagueId, season, week, rosterId: m.roster_id } },
            update: { matchupId: m.matchup_id ?? null, points: m.points ?? 0 },
            create: {
              leagueId,
              season,
              week,
              rosterId: m.roster_id,
              matchupId: m.matchup_id ?? null,
              points: m.points ?? 0,
            },
          })
        )
      );
    }

    // TRANSACTIONS (weeks 0..18)
    let txFetched = 0;
    let txUpserted = 0;
    let assetsCreated = 0;

    for (let week = 0; week <= 18; week++) {
      const txs = await getTransactions(leagueId, week);
      txFetched += txs.length;

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
            rawJson: t as any,
          },
          create: {
            id: t.transaction_id,
            leagueId,
            season,
            week,
            type: t.type,
            status: t.status,
            createdAt: new Date(t.created),
            rawJson: t as any,
          },
        });
        txUpserted++;

        // rebuild assets deterministically
        await db.transactionAsset.deleteMany({ where: { transactionId: t.transaction_id } });

        const adds = t.adds ?? {};
        const drops = t.drops ?? {};

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
          assetsCreated++;
        }

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
          assetsCreated++;
        }

        for (const p of t.draft_picks ?? []) {
          const pickSeason =
            p.season === null || p.season === undefined ? null : Number(p.season);

          await db.transactionAsset.create({
            data: {
              transactionId: t.transaction_id,
              kind: "pick",
              fromRosterId: p.previous_owner_id ?? null,
              toRosterId: p.owner_id ?? null,
              pickSeason, // ✅ coerced to Int|null
              pickRound: p.round ?? null,
            },
          });
          assetsCreated++;
        }

        const faab = t.settings?.waiver_budget;
        if (typeof faab === "number") {
          await db.transactionAsset.create({
            data: {
              transactionId: t.transaction_id,
              kind: "faab",
              faabAmount: faab,
              fromRosterId: null,
              toRosterId: null,
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
      transactionsFetched: txFetched,
      transactionsUpserted: txUpserted,
      assetsCreated,
    });
  } catch (e: any) {
    console.error("SYNC ERROR:", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
