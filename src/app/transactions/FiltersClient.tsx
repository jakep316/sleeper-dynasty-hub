"use client";

import { useRouter } from "next/navigation";

function buildQueryString(params: Record<string, string | number | null | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === "all") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export default function FiltersClient({
  rootParam,
  seasonParam,
  teamParam,
  typeParam,
  seasons,
  types,
  rosters,
}: {
  rootParam: string;
  seasonParam: string;
  teamParam: string;
  typeParam: string;
  seasons: number[];
  types: string[];
  rosters: Array<{ id: number; label: string }>;
}) {
  const router = useRouter();

  const base = {
    root: rootParam,
    season: seasonParam,
    team: teamParam,
    type: typeParam,
    page: 1,
  };

  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <label className="text-xs font-semibold text-zinc-600">Season</label>
          <select
            className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={seasonParam}
            onChange={(e) =>
              router.push(`/transactions${buildQueryString({ ...base, season: e.target.value })}`)
            }
          >
            <option value="all">All</option>
            {seasons.map((s) => (
              <option key={s} value={String(s)}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-semibold text-zinc-600">Type</label>
          <select
            className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={typeParam}
            onChange={(e) =>
              router.push(`/transactions${buildQueryString({ ...base, type: e.target.value })}`)
            }
          >
            <option value="all">All</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1">
          <label className="text-xs font-semibold text-zinc-600">Team</label>
          <select
            className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={teamParam}
            onChange={(e) =>
              router.push(`/transactions${buildQueryString({ ...base, team: e.target.value })}`)
            }
          >
            <option value="all">All</option>
            {rosters.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <a
          href={`/transactions${buildQueryString({ root: rootParam })}`}
          className="ml-auto rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
        >
          Clear
        </a>
      </div>
    </div>
  );
}
