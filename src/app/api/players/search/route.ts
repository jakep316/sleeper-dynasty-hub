import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const qRaw = (url.searchParams.get("q") ?? "").trim();

    if (qRaw.length < 3) {
      return NextResponse.json({ ok: true, q: qRaw, results: [] });
    }

    const q = qRaw;

    // Basic contains search, then rank so "startsWith" rises
    const rows = await db.sleeperPlayer.findMany({
      where: {
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { team: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { id: true, fullName: true, position: true, team: true, status: true },
      take: 25,
    });

    const lower = q.toLowerCase();

    const ranked = rows
      .map((r) => {
        const name = (r.fullName ?? "").toLowerCase();
        const starts = name.startsWith(lower) ? 0 : 1;
        return { ...r, _rank: starts };
      })
      .sort((a, b) => a._rank - b._rank || (a.fullName ?? "").localeCompare(b.fullName ?? ""))
      .slice(0, 10)
      .map(({ _rank, ...rest }) => rest);

    return NextResponse.json({ ok: true, q: qRaw, results: ranked });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
