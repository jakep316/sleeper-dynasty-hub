import { db } from "@/lib/db";
import { getRosterNameMap } from "@/lib/names";

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

  const rosterNames = await getRosterNameMap(leagueId, season);
  const nameOf = (rosterId: number) => rosterNames.get(rosterId) ?? `Roster ${rosterId}`;

  const matchups = await db.matchup.findMany({
    where: { leagueId, season, matchupId: { not: null } },
    orderBy: [{ week: "asc" }, { matchupId: "asc" }],
  });

  // group by (week, matchupId) -> two rows (one per roster)
  const groups = new Map<string, typeof matchups>();
  for (const m of matchups) {
    const k = `${m.week}-${m.matchupId}`;
    const arr = groups.get(k) ?? [];
    arr.push(m);
    groups.set(k, arr);
  }

  const h2h = new Map<
    Key,
    {
      a: number;
      b: number;
      aw: number;
      bw: number;
      ties: number;
      games: number;
      apf: number;
      bpf: number;
    }
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

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
        <thead>
          <tr>
            {["Pair", "Games", "Left W", "Right W", "Ties", "Left PF", "Right PF"].map((h) => (
              <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((r) => (
            <tr key={`${r.a}-${r.b}`}>
              <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>
                {nameOf(r.a)} vs {nameOf(r.b)}
              </td>
              <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.games}</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.aw}</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.bw}</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.ties}</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.apf.toFixed(2)}</td>
              <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.bpf.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
