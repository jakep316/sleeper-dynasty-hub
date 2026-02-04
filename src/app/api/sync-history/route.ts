import { NextResponse } from "next/server";
import { getLeague } from "@/lib/sleeper";

/**
 * Walks the Sleeper previous_league_id chain starting from:
 *   - ?leagueId=... (optional)
 *   - otherwise SLEEPER_LEAGUE_ID
 *
 * Then calls /api/sync?leagueId=... for each id (newest -> oldest).
 *
 * POST /api/sync-history
 * POST /api/sync-history?leagueId=123&maxDepth=15
 */
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const startLeagueId = url.searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID!;
    const maxDepth = Number(url.searchParams.get("maxDepth") ?? 15);

    if (!startLeagueId) {
      return NextResponse.json({ ok: false, error: "Missing start leagueId" }, { status: 400 });
    }

    // Build the chain newest -> oldest
    const chain: string[] = [];
    const seen = new Set<string>();

    let current: string | null = startLeagueId;

    for (let i = 0; i < maxDepth && current; i++) {
      if (seen.has(current)) break;
      seen.add(current);
      chain.push(current);

      const meta = await getLeague(current);
      current = meta.previous_league_id ?? null;
    }

    const origin = url.origin;

    const results: Array<{ leagueId: string; ok: boolean; status: number; body: any }> = [];

    for (const leagueId of chain) {
      const res = await fetch(`${origin}/api/sync?leagueId=${encodeURIComponent(leagueId)}`, {
        method: "POST",
      });

      let body: any;
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }

      results.push({ leagueId, ok: res.ok, status: res.status, body });

      if (!res.ok || (body && body.ok === false)) {
        return NextResponse.json(
          { ok: false, startLeagueId, chain, results },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      ok: true,
      startLeagueId,
      chain,
      syncedCount: results.length,
      results,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
