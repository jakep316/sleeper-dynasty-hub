// src/app/api/players/search/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();

    if (q.length < 3) {
      return NextResponse.json({ ok: true, q, results: [] });
    }

    const rows = await db.sleeperPlayer.findMany({
      where: {
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { team: { contains: q, mode: "insensitive" } },
        ],
      },
      take: 25,
      select: { id: true, fullName: true, position: true, team: true, status: true },
    });

    // rank: startsWith > contains
    const ql = q.toLowerCase();
    const scored = rows
      .map((r) => {
        const name = (r.fullName ?? "").toLowerCase();
        const score = name.startsWith(ql) ? 0 : name.includes(ql) ? 1 : 2;
        return { r, score };
      })
      .sort((a, b) => a.score - b.score);

    return NextResponse.json({ ok: true, q, results: scored.map((s) => s.r).slice(0, 10) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
