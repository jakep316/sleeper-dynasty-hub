import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getLeague,
  getLeagueRosters,
  getLeagueUsers,
  getMatchups,
  getTransactions,
} from "@/lib/sleeper";

export async function POST() {
  try {
    const leagueId = process.env.SLEEPER_LEAGUE_ID!;
    const league = await getLeague(leagueId);

    const season = Number(league.season ?? new Date().getFullYear());
    const previousLeagueId = league.previous_league_id ?? null;

    await db.leagueSeason.upsert({
      where: { leagueId_season: { leagueId, season } },
      update: { previousLeagueId },
      create: { leagueId, season, previousLeagueId },
    });

    const users = await getLeagueUsers(leagueId);
    for (const u of users) {
      await db.sleeperUser.upsert({
        where: { sleeperUserId: u.user_id },
        update: {
          username: u.username ?? null,
          displayName: u.display_name ?? null,
          avatar: u.avatar ?? null,
        },
        create: {
          sleeperUserId: u.user_id,
          username: u.username ?? null,
          displayName: u.display_name ?? null,
          avatar: u.avatar ?? null,
        },
      });
    }

    const rosters = await getLeagueRosters(leagueId);
    for (const r of rosters) {
      await db.roster.upsert({
        where: { leagueId_season_rosterId: { leagueId, season, rosterId: r.roster_id } },
        update: {
          ownerId: r.owner_id ?? null,
          settingsJson: r.settings ?? null,
        },
        create: {
          leagueId,
          season,
          rosterId: r.roster_id,
          ownerId: r.owner_id ?? null,
          settingsJson: r.settings ?? null,
        },
      });
    }

    const MAX = 18;
    for (let week = 1; week <= MAX; week++) {
      const ms = await getMatchups(leagueId, week);
      if (Array.isArray(ms) && ms.length) {
        for (const m of ms) {
          await db.matchup.upsert({
            where: {
              leagueId_season_week_rosterId: { leagueId, season, week, rosterId: m.roster_id },
            },
            update: {
              matchupId: m.matchup_id ?? null,
              points: typeof m.points === "number" ? m.points : null,
            },
            create: {
              leagueId,
              season,
              week,
              rosterId: m.roster_id,
              matchupId: m.matchup_id ?? null,
              points: typeof m.points === "number" ? m.points : null,
            },
          });
        }
      }

      const txs = await getTransactions(leagueId, week);
      if (Array.isArray(txs) && txs.length) {
        for (const t of txs) {
          await db.transaction.upsert({
            where: { id: String(t.transaction_id) },
            update: {
              type: String(t.type),
              status: String(t.status),
              createdAtMs: BigInt(t.created ?? 0),
              updatedAtMs: BigInt(t.status_updated ?? 0),
              rawJson: t,
            },
            create: {
              id: String(t.transaction_id),
              leagueId,
              season,
              week,
              type: String(t.type),
              status: String(t.status),
              createdAtMs: BigInt(t.created ?? 0),
              updatedAtMs: BigInt(t.status_updated ?? 0),
              rawJson: t,
            },
          });

          await db.transactionAsset.deleteMany({
            where: { transactionId: String(t.transaction_id) },
          });

          const adds = t.adds ?? {};
          const drops = t.drops ?? {};

          for (const [playerId, toRosterId] of Object.entries(adds)) {
            await db.transactionAsset.create({
              data: {
                transactionId: String(t.transaction_id),
                kind: "player",
                fromRosterId: null,
                toRosterId: Number(toRosterId),
                playerId: String(playerId),
              },
            });
          }

          for (const [playerId, fromRosterId] of Object.entries(drops)) {
            await db.transactionAsset.create({
              data: {
                transactionId: String(t.transaction_id),
                kind: "player_drop",
                fromRosterId: Number(fromRosterId),
                toRosterId: null,
                playerId: String(playerId),
              },
            });
          }

          for (const p of t.draft_picks ?? []) {
            await db.transactionAsset.create({
              data: {
                transactionId: String(t.transaction_id),
                kind: "pick",
                fromRosterId: p.previous_owner_id ?? null,
                toRosterId: p.owner_id ?? null,
                pickSeason: Number(p.season ?? 0) || null,
                pickRound: Number(p.round ?? 0) || null,
              },
            });
          }

          for (const b of t.waiver_budget ?? []) {
            await db.transactionAsset.create({
              data: {
                transactionId: String(t.transaction_id),
                kind: "faab",
                fromRosterId: b.sender ?? null,
                toRosterId: b.receiver ?? null,
                faabAmount: Number(b.amount ?? 0) || 0,
              },
            });
          }
        }
      }
    }

    return NextResponse.json({ ok: true, leagueId, season });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
