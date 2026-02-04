import { db } from "@/lib/db";

type Key = string;

export default async function H2HPage() {
  const leagueId = process.env.SLEEPER_LEAGUE_ID!;
  const seasonRow = await db.leagueSeason.findFirst({
    where: { leagueId },
    orderBy: { season: "desc" },
  });

  if (!seasonRow) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Head-to-Head</h1>
        <p>No data yet. Run sync: POST /api/sync</p>
      </div>
    );
  }

  const season = seasonRow.season;
  const matchups = await db.matchup.findMany({
    where: { leagueId, season, matchupId: { not: null } },
    orderBy: [{ week: "asc" }, { matchupId: "asc" }],
  });

  const groups = new Map<string, typeof matchups>();
  for (const m of matchups) {
    const k = `${m.week}-${m.matchupId}`;
    const arr = groups.get(k) ?? [];
    arr.push(m);
    groups.set(k, arr);
  }

  const h2h = new Map<
    Key,
    { a: number; b: number; aw: number; bw: number; ties: number; games: number; apf: number; bpf: number }
  >();

  for (const [, g] of groups) {
    if (g.length !== 2) continue;
    const [m1, m2] = g;
    const a = Math.min(m1.rosterId, m2.rosterId);
    const b = Math.max(m1.rosterId, m2.rosterId);
    const key = `${a}-${b}`;

    const rec = h2h.get(key) ?? { a, b, aw: 0, bw: 0, ties: 0, games: 0, apf: 0, bpf: 0 };

    const p1 = m1.points ?? 0;
    const p2 = m2.points ?? 0;

    const aPoints = m1.rosterId === a ? p1 : p2;
    const bPoints = m1.rosterId === a ? p2 : p1;

    rec.apf += aPoints;
    rec.bpf += bPoints;
    rec.games += 1;

    if (aPoints > bPoints) rec.aw += 1;
    else if (bPoints > aPoints) rec.bw += 1;
    else rec.ties += 1;

    h2h.set(key, rec);
  }

  const rows = Array.from(h2h.values()).sort((x, y) => y.games - x.games);

  return (
    <div style={{ padding: 24 }}>
      <h1>Head-to-Head</h1>
      <p>Season {season}</p>

      {rows.map((r) => (
        <div key={`${r.a}-${r.b}`}>
          {r.a} vs {r.b} — {r.aw}-{r.bw}-{r.ties}
        </div>
      ))}
    </div>
  );
}
