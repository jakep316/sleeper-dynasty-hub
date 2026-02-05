import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

function normalize(s: string) {
  return s.trim().toLowerCase();
}

type PlayerRow = {
  id: string;
  fullName: string | null;
  position: string | null;
  team: string | null;
  status: string | null;
};

function getPlayerDelegate(prisma: any) {
  // Try common Prisma delegate names.
  // Add/remove items here based on your schema model name.
  const candidates = [
    "sleeperPlayer",   // model SleeperPlayer
    "SleeperPlayer",   // (unlikely but harmless)
    "player",          // model Player
    "nflPlayer",       // model NflPlayer
    "sleeperNflPlayer",
    "SleeperNflPlayer",
  ];

  for (const key of candidates) {
    if (prisma && prisma[key] && typeof prisma[key].findMany === "function") {
      return prisma[key];
    }
  }
  return null;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const qRaw = searchParams.get("q") ?? "";
    const limitRaw = Number(searchParams.get("limit") ?? 10);
    const limit = Math.max(1, Math.min(25, Number.isFinite(limitRaw) ? limitRaw : 10));

    const q = normalize(qRaw);

    // Start autocomplete at 3+ characters
    if (q.length < 3) {
      return NextResponse.json({ ok: true, q: qRaw, results: [] });
    }

    const delegate = getPlayerDelegate(db as any);
    if (!delegate) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Could not find a Prisma model delegate for players. Check prisma/schema.prisma for the Player model name and update candidates list in /api/players/search.",
        },
        { status: 500 }
      );
    }

    // Pull more than we need, then rank so startsWith appears first.
    const rows: PlayerRow[] = await delegate.findMany({
      where: {
        OR: [{ fullName: { contains: q, mode: "insensitive" } }],
      },
      select: { id: true, fullName: true, position: true, team: true, status: true },
      take: 100,
    });

    const ranked = rows
      .map((p) => {
        const name = (p.fullName ?? "").toLowerCase();
        const starts = name.startsWith(q);
        const idx = name.indexOf(q);
        const score =
          (starts ? 0 : 100) +
          (idx >= 0 ? idx : 999) +
          ((p.status ?? "").toLowerCase() === "active" ? -2 : 0);

        return { p, score };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map(({ p }) => ({
        id: p.id,
        fullName: p.fullName,
        position: p.position,
        team: p.team,
        status: p.status,
      }));

    return NextResponse.json({ ok: true, q: qRaw, results: ranked });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
