import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAllNflPlayers } from "@/lib/sleeper";

function hoursSince(dateMs: number) {
  return (Date.now() - dateMs) / (1000 * 60 * 60);
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

    // Smaller chunk + longer transaction timeout to avoid Prisma 5s rollback timeout
    const CHUNK = 100;

    for (let i = 0; i < entries.length; i += CHUNK) {
      const slice = entries.slice(i, i + CHUNK);

      const ops = slice.map(([id, p]) =>
        db.sleeperPlayer.upsert({
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
        })
      );

      // IMPORTANT: bump timeout (ms). If your Prisma version doesn't accept this,
      // we’ll switch to non-transaction batching.
      await db.$transaction(ops, { timeout: 60000, maxWait: 60000 });
    }

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
