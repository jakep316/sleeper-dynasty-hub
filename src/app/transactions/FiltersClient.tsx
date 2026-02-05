"use client";

import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Props = {
  rootParam: string; // not used right now, but keeping since you pass it
  seasonParam: string;
  teamParam: string;
  typeParam: string;
  seasons: number[];
  types: string[];
  rosters: { id: number; label: string }[];
};

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function FiltersClient({
  seasonParam,
  teamParam,
  typeParam,
  seasons,
  types,
  rosters,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const current = useMemo(() => {
    return {
      season: seasonParam ?? "all",
      team: teamParam ?? "all",
      type: typeParam ?? "all",
      page: sp.get("page") ?? "1",
    };
  }, [seasonParam, teamParam, typeParam, sp]);

  function setParam(key: "season" | "team" | "type", value: string) {
    const next = new URLSearchParams(sp.toString());

    if (!value || value === "all") next.delete(key);
    else next.set(key, value);

    // ✅ IMPORTANT: changing a filter should reset to page 1
    next.delete("page");

    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function resetAll() {
    router.push(pathname);
  }

  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px]">
          <div className="text-xs font-semibold text-zinc-600 mb-1">Season</div>
          <select
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={current.season}
            onChange={(e) => setParam("season", e.target.value)}
          >
            <option value="all">All</option>
            {seasons.map((s) => (
              <option key={s} value={String(s)}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-[220px]">
          <div className="text-xs font-semibold text-zinc-600 mb-1">Team</div>
          <select
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={current.team}
            onChange={(e) => setParam("team", e.target.value)}
          >
            <option value="all">All</option>
            {rosters.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-[180px]">
          <div className="text-xs font-semibold text-zinc-600 mb-1">Type</div>
          <select
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={current.type}
            onChange={(e) => setParam("type", e.target.value)}
          >
            <option value="all">All</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {prettyType(t)}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={resetAll}
          className="rounded-xl px-4 py-2 text-sm font-semibold border border-zinc-200 hover:bg-zinc-50"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
