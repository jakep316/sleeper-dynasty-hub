import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAllNflPlayers } from "@/lib/sleeper";

export const dynamic = "force-dynamic";

/**
 * Find the Prisma delegate that represents your NFL players table/model.
 * Add candidates here if your Prisma model is named differently.
 */
function getPlayerDelegate(prisma: any) {
  const candidates = [
    "sleeperPlayer", // model SleeperPlayer
    "player", // model Player
    "nflPlayer", // model NflPlayer
    "sleeperNflPlayer",
    "SleeperPlayer",
    "SleeperNflPlayer",
  ];

  for (const key of candidates) {
    if (prisma && prisma[key] && typeof prisma[key].upsert === "function") {
      return prisma[key];
    }
  }
  return null;
}

/**
 * Simple concurrency limiter (no deps).
 */
function pLimit(concurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    activeCount--;
    const run = queue.shift();
    if (run) run();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        activeCount++;
        fn()
          .then(resolve)
          .catch(reject)
          .finally(next);
      };

      if (activeCount < concurrency) run();
      else queue.push(run);
    });
  };
}

type SleeperNflPlayer = {
  player_id?: string;
  full_name?: string;
  position?: string;
  team?: string;
  status?: string;
};

export async function POST() {
  try {
    const delegate = getPlayerDelegate(db as any);
    if (!delegate) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Could not find a Prisma model delegate for players. Check prisma/schema.prisma for the Player model name and update candidates list in /api/players/sync.",
        },
        { status: 500 }
      );
    }

    // Fetch Sleeper players (big object keyed by player_id)
    const all = await getAllNflPlayers();
    const entries = Object.entries(all ?? {}) as Array<[string, SleeperNflPlayer]>;

    // Build normalized rows
    const rows = entries.map(([id, p]) => ({
      id,
      fullName: p.full_name ?? null,
      position: p.position ?? null,
      team: p.team ?? null,
      status: p.status ?? null,
    }));

    // Upsert in batches with concurrency limit to avoid timeouts
    const limit = pLimit(20);
    const BATCH = 500;

    let upserted = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);

      await Promise.all(
        batch.map((r) =>
          limit(async () => {
            await delegate.upsert({
              where: { id: r.id },
              update: {
                fullName: r.fullName,
                position: r.position,
                team: r.team,
                status: r.status,
                updatedAt: new Date(),
              },
              create: {
                id: r.id,
                fullName: r.fullName,
                position: r.position,
                team: r.team,
                status: r.status,
                updatedAt: new Date(),
              },
            });
            upserted++;
          })
        )
      );
    }

    return NextResponse.json({ ok: true, count: upserted });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
