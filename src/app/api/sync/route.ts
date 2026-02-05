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
            rawJson: t,
          },
        });

        transactionsUpserted++;

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

function toInt(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build TransactionAsset rows from a Sleeper txn.
 * - Players: from adds/drops pairing (so trades have both sides)
 * - Picks: from draft_picks (coerce ids robustly)
 * - FAAB: from waiver_budget if present
 */
function buildMovements(t: any) {
  const adds: Record<string, any> = t.adds ?? {};
  const drops: Record<string, any> = t.drops ?? {};
  const draftPicks: any[] = Array.isArray(t.draft_picks) ? t.draft_picks : [];
  const waiverBudget: any[] = Array.isArray(t.waiver_budget) ? t.waiver_budget : [];

  const movements: any[] = [];

  // Pair adds/drops by asset id (players primarily)
  const allIds = new Set<string>([...Object.keys(adds), ...Object.keys(drops)]);
  for (const id of allIds) {
    movements.push({
      kind: "player",
      playerId: id,
      fromRosterId: toInt(drops[id]),
      toRosterId: toInt(adds[id]),
    });
  }

  // Picks (draft_picks) - robust parsing for older seasons
  for (const p of draftPicks) {
    const pickSeason = toInt(p.season);
    const pickRound = toInt(p.round);

    // "owner_id" / "previous_owner_id" are usually rosterIds but may be strings; sometimes other keys exist
    const toRosterId = toInt(
      p.owner_id ?? p.roster_id ?? p.owner_roster_id ?? p.ownerRosterId ?? null
    );
    const fromRosterId = toInt(
      p.previous_owner_id ??
        p.previous_owner_roster_id ??
        p.previousOwnerId ??
        p.previousOwnerRosterId ??
        null
    );

    movements.push({
      kind: "pick",
      pickSeason,
      pickRound,
      fromRosterId,
      toRosterId,
    });
  }

  // FAAB (optional)
  for (const b of waiverBudget) {
    const from = toInt(b?.from);
    const to = toInt(b?.to);
    const amount = toInt(b?.amount);

    if (from !== null && to !== null && amount !== null) {
      movements.push({
        kind: "faab",
        faabAmount: amount,
        fromRosterId: from,
        toRosterId: to,
      });
    }
  }

  return movements;
}
