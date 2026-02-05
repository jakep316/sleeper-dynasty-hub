import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Find the Prisma delegate for your players model.
 * Add candidates if your Prisma model is named differently.
 */
function getPlayerDelegate(prisma: any) {
  const candidates = [
    "sleeperPlayer", // model SleeperPlayer
    "player",        // model Player
    "nflPlayer",     // model NflPlayer
    "sleeperNflPlayer",
    "SleeperPlayer",
    "SleeperNflPlayer",
  ];

  for (const key of candidates) {
    if (prisma && prisma[key] && typeof prisma[key].findMany === "function") {
      return prisma[key];
    }
  }
  return null;
}

type PlayerRow = { id: string; fullName: string | null; position: string | null; team: string | null };

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const leagueId = searchParams.get("leagueId") ?? process.env.SLEEPER_LEAGUE_ID ?? "";
    if (!leagueId) {
      return NextResponse.json({ ok: false, error: "Missing leagueId (or SLEEPER_LEAGUE_ID env var)" }, { status: 400 });
    }

    const seasonsParam = searchParams.get("seasons") ?? ""; // comma-separated
    const typesParam = searchParams.get("types") ?? "";     // comma-separated
    const teamParam = searchParams.get("team") ?? "all";    // rosterId or "all"

    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(searchParams.get("pageSize") ?? 50)));

    const seasons = seasonsParam
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));

    const types = typesParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // ---- WHERE ----
    const where: any = { leagueId };
    if (seasons.length > 0) where.season = { in: seasons };
    if (types.length > 0) where.type = { in: types };

    if (teamParam !== "all" && teamParam !== "") {
      const teamId = Number(teamParam);
      if (Number.isFinite(teamId)) {
        where.assets = { some: { OR: [{ fromRosterId: teamId }, { toRosterId: teamId }] } };
      }
    }

    // ---- Query transactions ----
    const [total, txs] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.findMany({
        where,
        orderBy: [{ season: "desc" }, { week: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { assets: true },
      }),
    ]);

    // ---- Build roster labels (owner names) for any league/season pairs in this payload ----
    const pairs = Array.from(new Set(txs.map((t) => `${t.leagueId}::${t.season}`))).map((k) => {
      const [lid, s] = k.split("::");
      return { leagueId: lid, season: Number(s) };
    });

    const rosters =
      pairs.length > 0
        ? await db.roster.findMany({
            where: { OR: pairs.map((p) => ({ leagueId: p.leagueId, season: p.season })) },
            select: { leagueId: true, season: true, rosterId: true, ownerId: true },
          })
        : [];

    const ownerIds = uniq(rosters.map((r) => r.ownerId).filter((x): x is string => !!x));
    const owners =
      ownerIds.length > 0
        ? await db.sleeperUser.findMany({
            where: { sleeperUserId: { in: ownerIds } },
            select: { sleeperUserId: true, displayName: true, username: true },
          })
        : [];

    const ownerMap = new Map(owners.map((o) => [o.sleeperUserId, o.displayName ?? o.username ?? o.sleeperUserId]));
    const rosterLabelMap = new Map<string, string>();

    for (const r of rosters) {
      const label = (r.ownerId && ownerMap.get(r.ownerId)) || `Roster ${r.rosterId}`;
      rosterLabelMap.set(`${r.leagueId}::${r.season}::${r.rosterId}`, label);
    }

    const rosterLabel = (lid: string, season: number, rosterId: number | null | undefined) => {
      if (rosterId === null || rosterId === undefined) return "—";
      return rosterLabelMap.get(`${lid}::${season}::${rosterId}`) ?? `Roster ${rosterId}`;
    };

    // ---- Player map ----
    const playerIds = uniq(
      txs
        .flatMap((t) => t.assets)
        .map((a) => a.playerId)
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    );

    const playerDelegate = getPlayerDelegate(db as any);

    const players: PlayerRow[] =
      playerIds.length > 0 && playerDelegate
        ? await playerDelegate.findMany({
            where: { id: { in: playerIds } },
            select: { id: true, fullName: true, position: true, team: true },
          })
        : [];

    const playerMap = new Map(players.map((p) => [p.id, p]));

    const playerLabel = (id: string) => {
      const p = playerMap.get(id);
      if (!p) return `Player ${id}`;
      const name = p.fullName ?? `Player ${id}`;
      const parts = [p.position, p.team].filter(Boolean);
      return parts.length ? `${name} (${parts.join(", ")})` : name;
    };

    const pickLabel = (a: any) => {
      const ys = typeof a.pickSeason === "number" ? String(a.pickSeason) : "?";
      const rd = typeof a.pickRound === "number" ? String(a.pickRound) : "?";
      const own = typeof a.pickOriginalOwnerRosterId === "number" ? ` (${rosterLabel(a.pickOriginalOwnerLeagueId ?? leagueId, a.pickSeason ?? 0, a.pickOriginalOwnerRosterId)} pick)` : "";
      return `${ys} R${rd}${own}`;
    };

    const assetLabel = (t: any, a: any) => {
      if (a.kind === "pick") return pickLabel(a);
      if (a.kind === "faab") return `FAAB $${a.faabAmount ?? 0}`;
      if (a.playerId) return playerLabel(a.playerId);
      return a.kind ?? "asset";
    };

    function getTeamsString(t: any) {
      if (t.type === "trade") {
        const involved: number[] = [];
        for (const a of t.assets) {
          const from = a.fromRosterId;
          const to = a.toRosterId;
          if (typeof from === "number") involved.push(from);
          if (typeof to === "number") involved.push(to);
        }
        const clean = uniq(involved).map((rid) => rosterLabel(t.leagueId, t.season, rid)).filter((x) => x !== "—");
        if (clean.length === 2) return `${clean[0]} ↔ ${clean[1]}`;
        if (clean.length > 2) return clean.join(" ↔ ");
        return clean[0] ?? "—";
      }

      const fromTeams = new Set<number>();
      const toTeams = new Set<number>();
      for (const a of t.assets) {
        if (typeof a.fromRosterId === "number") fromTeams.add(a.fromRosterId);
        if (typeof a.toRosterId === "number") toTeams.add(a.toRosterId);
      }

      const labels = uniq([
        ...Array.from(fromTeams).map((rid) => rosterLabel(t.leagueId, t.season, rid)),
        ...Array.from(toTeams).map((rid) => rosterLabel(t.leagueId, t.season, rid)),
      ]).filter((x) => x !== "—");

      return labels.length ? labels.join(", ") : "—";
    }

    function getMoves(t: any) {
      if (t.type === "trade") {
        const received = new Map<number, string[]>();
        for (const a of t.assets) {
          const from = a.fromRosterId;
          const to = a.toRosterId;
          if (typeof from === "number" && typeof to === "number" && from !== to) {
            const list = received.get(to) ?? [];
            list.push(assetLabel(t, a));
            received.set(to, list);
          }
        }

        const teamIds = Array.from(received.keys()).sort((a, b) => a - b);
        return teamIds.map((rid) => ({
          rosterId: rid,
          team: rosterLabel(t.leagueId, t.season, rid),
          received: received.get(rid) ?? [],
        }));
      }

      const adds: string[] = [];
      const drops: string[] = [];
      const faabByTo = new Map<number, number>();

      for (const a of t.assets) {
        if (a.kind === "faab" && typeof a.toRosterId === "number") {
          faabByTo.set(a.toRosterId, (faabByTo.get(a.toRosterId) ?? 0) + (a.faabAmount ?? 0));
        }

        if (!a.playerId) continue;
        const label = playerLabel(a.playerId);
        if (a.fromRosterId && !a.toRosterId) drops.push(label);
        if (!a.fromRosterId && a.toRosterId) adds.push(label);
      }

      const teams = getTeamsString(t);
      const faab = Array.from(faabByTo.entries()).map(([rid, amt]) => ({
        team: rosterLabel(t.leagueId, t.season, rid),
        amount: amt,
      }));

      return { teams, adds, drops, faab };
    }

    const items = txs.map((t) => ({
      id: t.id,
      leagueId: t.leagueId,
      season: t.season,
      week: t.week,
      type: t.type,
      typeLabel: prettyType(t.type),
      createdAt: t.createdAt,
      teams: getTeamsString(t),
      moves: getMoves(t),
    }));

    return NextResponse.json({
      ok: true,
      leagueId,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
