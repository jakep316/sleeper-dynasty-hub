import { NextResponse } from "next/server";
import { getLeague } from "@/lib/sleeper";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const startLeagueId = url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID!;
    const maxDepth = Number(url.searchParams.get("maxDepth") ?? 25);

    if (!startLeagueId) {
      return NextResponse.json({ ok: false, error: "Missing leagueId" }, { status: 400 });
    }

    const chain: Array<{
      league_id: string;
      season: string;
      previous_league_id: string | null;
    }> = [];

    const seen = new Set<string>();
    let current: string | null = startLeagueId;

    for (let i = 0; i < maxDepth && current; i++) {
      if (seen.has(current)) break;
      seen.add(current);

      const meta = await getLeague(current);
      chain.push({
        league_id: meta.league_id,
        season: meta.season,
        previous_league_id: meta.previous_league_id ?? null,
      });

      current = meta.previous_league_id ?? null;
    }

    return NextResponse.json({
      ok: true,
      startLeagueId,
      chainLength: chain.length,
      chain,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
