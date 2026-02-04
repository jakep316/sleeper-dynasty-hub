import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAllNflPlayers } from "@/lib/sleeper";

function hoursSince(dateMs: number) {
  return (Date.now() - dateMs) / (1000 * 60 * 60);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  let i = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

export async function POST() {
  try {
    const metaKey = "players_nfl_last_sync_ms";
    const meta = await db.appMeta.findUnique({ where: { key: metaKey } });

    if (meta?.value) {
      const last = Number(meta.value);
      if (Number.isFinite(last) && hoursSince(last) < 24) {
        return NextResponse.json({ ok: true, skipped: true, reason: "synced_recently" });
      }
    }

    const players = await getAllNflPlayers();
    const entries = Object.entries(players);

    // Limit concurrency to avoid hammering DB / timing out
    const CONCURRENCY = 10;

    await runWithConcurrency(entries, CONCURRENCY, async ([id, p]) => {
      await db.sleeperPlayer.upsert({
        where: { id },
        update: {
          fullName: p?.full_name ?? null,
          position: p?.position ?? null,
          team: p?.team ?? null,
          status: p?.status ?? null,
        },
        create: {
          id,
          fullName: p?.full_name ?? null,
          position: p?.position ?? null,
          team: p?.team ?? null,
          status: p?.status ?? null,
        },
      });
    });

    await db.appMeta.upsert({
      where: { key: metaKey },
      update: { value: String(Date.now()) },
      create: { key: metaKey, value: String(Date.now()) },
    });

    return NextResponse.json({ ok: true, count: entries.length });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
