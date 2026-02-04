import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const leagueId = url.searchParams.get("leagueId"); // optional
    const take = Number(url.searchParams.get("take") ?? 5);

    const where: any = {};
    if (leagueId) where.leagueId = leagueId;

    const [total, byLeague, newest, oldest, sample] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.groupBy({
        by: ["leagueId"],
        where,
        _count: { _all: true },
        orderBy: { _count: { _all: "desc" } },
      }),
      db.transaction.findFirst({
        where,
        orderBy: { createdAt: "desc" },
        select: { id: true, leagueId: true, season: true, week: true, type: true, createdAt: true },
      }),
      db.transaction.findFirst({
        where,
        orderBy: { createdAt: "asc" },
        select: { id: true, leagueId: true, season: true, week: true, type: true, createdAt: true },
      }),
      db.transaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(take, 1), 25),
        select: { id: true, leagueId: true, season: true, week: true, type: true, createdAt: true },
      }),
    ]);

    return NextResponse.json({
      ok: true,
      filterLeagueId: leagueId ?? null,
      total,
      byLeague,
      newest,
      oldest,
      sample,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
