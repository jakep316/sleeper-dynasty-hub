import { db } from "@/lib/db";
import { getRosterNameMap } from "@/lib/names";

export default async function H2HPage() {
  const leagueId = process.env.SLEEPER_LEAGUE_ID!;
  const seasonRow = await db.leagueSeason.findFirst({
    where: { leagueId },
    orderBy: { season: "desc" },
  });

  if (!seasonRow) {
    return (
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Head-to-Head</h1>
        <p className="mt-2 text-sm text-zinc-600">No data yet. Run sync: POST /api/sync</p>
      </div>
    );
  }

  const season = seasonRow.season;
  const rosterNames = await getRosterNameMap(leagueId, season);
  const nameOf = (id: number) => rosterNames.get(id) ?? `Roster ${id}`;

  const matchups = await db.matchup.findMany({
    where: { leagueId, season, matchupId: { not: null } },
    orderBy: [{ week: "asc" }, { matchupId: "asc" }],
  });

  // group by (week, matchupId) -> two rows
  const groups = new Map<string, typeof matchups>();
  for (const m of matchups) {
    const k = `${m.week}-${m.matchupId}`;
    const arr = groups.get(k) ?? [];
    arr.push(m);
    groups.set(k, arr);
  }

  const h2h = new Map<
    string,
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
    <div className="grid gap-4">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Head-to-Head</h1>
        <p className="mt-1 text-sm text-zinc-600">Season {season}</p>
      </div>

      <div className="overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3 text-left">Matchup</th>
                <th className="px-4 py-3 text-right">Games</th>
                <th className="px-4 py-3 text-right">Left W</th>
                <th className="px-4 py-3 text-right">Right W</th>
                <th className="px-4 py-3 text-right">Ties</th>
                <th className="px-4 py-3 text-right">Left PF</th>
                <th className="px-4 py-3 text-right">Right PF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {rows.map((r) => (
                <tr key={`${r.a}-${r.b}`} className="hover:bg-zinc-50">
                  <td className="px-4 py-3 font-medium">
                    {nameOf(r.a)} <span className="text-zinc-400">vs</span> {nameOf(r.b)}
                  </td>
                  <td className="px-4 py-3 text-right">{r.games}</td>
                  <td className="px-4 py-3 text-right">{r.aw}</td>
                  <td className="px-4 py-3 text-right">{r.bw}</td>
                  <td className="px-4 py-3 text-right">{r.ties}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.apf.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.bpf.toFixed(2)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-zinc-500" colSpan={7}>
                    No matchups yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
