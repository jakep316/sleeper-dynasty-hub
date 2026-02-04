import { NextResponse } from "next/server";
import { getTransactions } from "@/lib/sleeper";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const leagueId = url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID!;
    const week = Number(url.searchParams.get("week") ?? 0);

    if (!leagueId) {
      return NextResponse.json({ ok: false, error: "Missing leagueId" }, { status: 400 });
    }
    if (!Number.isFinite(week) || week < 0 || week > 25) {
      return NextResponse.json({ ok: false, error: "Invalid week" }, { status: 400 });
    }

    const txs = await getTransactions(leagueId, week);

    // Return just a small sample so response isn't huge
    const sample = txs.slice(0, 3).map((t) => ({
      transaction_id: t.transaction_id,
      type: t.type,
      status: t.status,
      created: t.created,
      addsCount: t.adds ? Object.keys(t.adds).length : 0,
      dropsCount: t.drops ? Object.keys(t.drops).length : 0,
      picksCount: t.draft_picks?.length ?? 0,
    }));

    return NextResponse.json({
      ok: true,
      leagueId,
      week,
      count: txs.length,
      sample,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
