// src/app/transactions/TransactionsClient.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

type Facet = { value: string; label: string };

type TxTeamBlock = {
  rosterId: number;
  team: string;
  items: string[];
};

type TxItem = {
  id: string;
  leagueId: string;
  season: number;
  week: number;
  type: string;
  typeLabel: string;
  createdAt: string;
  teams: string[];
  received: TxTeamBlock[];
  sent: TxTeamBlock[];
};

type ApiResponse =
  | {
      ok: true;
      rootLeagueId: string;
      leagueIds: string[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
      items: TxItem[];
      facets: {
        seasons: Facet[];
        types: Facet[];
        teams: Facet[];
        teamsSeason: number;
      };
    }
  | { ok: false; error: string };

function toCsv(values: string[]) {
  const v = values.filter(Boolean);
  return v.length ? v.join(",") : "";
}

function fromCsv(value: string | null) {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export default function TransactionsClient({ leagueId }: { leagueId: string }) {
  const initial = useMemo(() => {
    const sp = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    return {
      seasons: fromCsv(sp.get("season")),
      types: fromCsv(sp.get("type")),
      teams: fromCsv(sp.get("team")),
      page: Math.max(1, Number(sp.get("page") ?? "1")),
    };
  }, []);

  const [selectedSeasons, setSelectedSeasons] = useState<string[]>(initial.seasons);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(initial.types);
  const [selectedTeams, setSelectedTeams] = useState<string[]>(initial.teams);
  const [page, setPage] = useState<number>(initial.page);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("leagueId", leagueId);

    const season = toCsv(selectedSeasons);
    const type = toCsv(selectedTypes);
    const team = toCsv(selectedTeams);

    if (season) sp.set("season", season);
    if (type) sp.set("type", type);
    if (team) sp.set("team", team);

    sp.set("page", String(page));
    sp.set("pageSize", "50");

    return sp.toString();
  }, [leagueId, selectedSeasons, selectedTypes, selectedTeams, page]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.search = qs;
    window.history.replaceState({}, "", url.toString());
  }, [qs]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      try {
        const res = await fetch(`/api/transactions?${qs}`, { cache: "no-store" });
        const json = (await res.json()) as ApiResponse;
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) setData({ ok: false, error: e?.message ?? String(e) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [qs]);

  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeasons.join(","), selectedTypes.join(","), selectedTeams.join(",")]);

  const facets = data && data.ok ? data.facets : null;

  const teamFacetClean = useMemo(() => {
    if (!facets) return [];
    return facets.teams.map((t) => ({
      ...t,
      label: t.label.replace(/^Roster\s+\d+\s*[-–:]?\s*/i, "").trim(),
    }));
  }, [facets]);

  function toggle(list: string[], value: string) {
    if (list.includes(value)) return list.filter((v) => v !== value);
    return [...list, value];
  }

  const totalPages = data && data.ok ? data.totalPages : 1;

  function renderMoves(t: TxItem) {
    // Trades: ONLY show "received" blocks to avoid duplication
    if (t.type === "trade") {
      if (!t.received?.length) return <span className="text-zinc-400">—</span>;
      return (
        <div className="space-y-2">
          {t.received.map((r) => (
            <div key={`recv-${t.id}-${r.rosterId}`} className="leading-snug">
              <div className="font-semibold text-zinc-900">{r.team} received</div>
              <div className="text-zinc-700">{r.items.join(", ")}</div>
            </div>
          ))}
        </div>
      );
    }

    // Non-trades: show Added / Dropped (not received/sent)
    const addedBlocks = t.received ?? [];
    const droppedBlocks = t.sent ?? [];

    // Most non-trade txns are single-team; just flatten items
    const added = addedBlocks.flatMap((b) => b.items);
    const dropped = droppedBlocks.flatMap((b) => b.items);

    if (!added.length && !dropped.length) return <span className="text-zinc-400">—</span>;

    return (
      <div className="space-y-1">
        {added.length > 0 && <div className="text-emerald-700">Added: {added.join(", ")}</div>}
        {dropped.length > 0 && <div className="text-rose-700">Dropped: {dropped.join(", ")}</div>}
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Transactions</h1>
            <p className="mt-1 text-sm text-zinc-600">
              {data?.ok ? (
                <>
                  Showing <span className="font-semibold text-zinc-900">{data.total}</span> total
                </>
              ) : (
                <>Sleeper league history</>
              )}
            </p>
          </div>

          <div className="text-sm text-zinc-500">
            {loading ? "Loading…" : data?.ok ? `Page ${data.page} of ${data.totalPages}` : ""}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <div className="text-sm font-semibold text-zinc-900 mb-2">Seasons</div>
            <div className="max-h-48 overflow-auto rounded-2xl border border-zinc-200 p-3 space-y-2">
              {facets?.seasons?.map((s) => (
                <label key={s.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedSeasons.includes(s.value)}
                    onChange={() => setSelectedSeasons((prev) => toggle(prev, s.value))}
                  />
                  <span>{s.label}</span>
                </label>
              ))}
              {!facets && <div className="text-sm text-zinc-500">Loading seasons…</div>}
            </div>
          </div>

          <div>
            <div className="text-sm font-semibold text-zinc-900 mb-2">Types</div>
            <div className="max-h-48 overflow-auto rounded-2xl border border-zinc-200 p-3 space-y-2">
              {facets?.types?.map((t) => (
                <label key={t.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedTypes.includes(t.value)}
                    onChange={() => setSelectedTypes((prev) => toggle(prev, t.value))}
                  />
                  <span>{t.label}</span>
                </label>
              ))}
              {!facets && <div className="text-sm text-zinc-500">Loading types…</div>}
            </div>
          </div>

          <div>
            <div className="text-sm font-semibold text-zinc-900 mb-2">Teams</div>
            <div className="max-h-48 overflow-auto rounded-2xl border border-zinc-200 p-3 space-y-2">
              {teamFacetClean?.map((t) => (
                <label key={t.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedTeams.includes(t.value)}
                    onChange={() => setSelectedTeams((prev) => toggle(prev, t.value))}
                  />
                  <span>{t.label}</span>
                </label>
              ))}
              {!facets && <div className="text-sm text-zinc-500">Loading teams…</div>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="text-zinc-600">
            Filters:
            <span className="ml-2 text-zinc-900 font-semibold">
              {selectedSeasons.length ? `${selectedSeasons.length} seasons` : "All seasons"}
            </span>
            <span className="mx-2 text-zinc-300">•</span>
            <span className="text-zinc-900 font-semibold">
              {selectedTypes.length ? `${selectedTypes.length} types` : "All types"}
            </span>
            <span className="mx-2 text-zinc-300">•</span>
            <span className="text-zinc-900 font-semibold">
              {selectedTeams.length ? `${selectedTeams.length} teams` : "All teams"}
            </span>
          </div>

          <button
            className="rounded-xl border border-zinc-200 px-3 py-2 hover:bg-zinc-50 font-semibold"
            onClick={() => {
              setSelectedSeasons([]);
              setSelectedTypes([]);
              setSelectedTeams([]);
              setPage(1);
            }}
          >
            Clear filters
          </button>
        </div>
      </div>

      {data?.ok === false && (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-5 text-rose-800">
          {data.error}
        </div>
      )}

      <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-600">
            <tr>
              <th className="text-left p-3">Season</th>
              <th className="text-left p-3">Week</th>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">Type</th>
              <th className="text-left p-3">Teams</th>
              <th className="text-left p-3">Moves</th>
            </tr>
          </thead>

          <tbody>
            {data?.ok &&
              data.items.map((t) => (
                <tr key={t.id} className="border-t align-top">
                  <td className="p-3 whitespace-nowrap">{t.season}</td>
                  <td className="p-3 whitespace-nowrap">{t.week}</td>
                  <td className="p-3 whitespace-nowrap">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </td>
                  <td className="p-3 whitespace-nowrap">{t.typeLabel}</td>
                  <td className="p-3 whitespace-nowrap">
                    {t.teams && t.teams.length ? t.teams.join(" ↔ ") : "—"}
                  </td>
                  <td className="p-3">{renderMoves(t)}</td>
                </tr>
              ))}

            {data?.ok && data.items.length === 0 && (
              <tr>
                <td className="p-6 text-zinc-600" colSpan={6}>
                  No transactions found with the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <button
          className={`rounded-xl px-3 py-2 font-semibold ${
            page <= 1 ? "text-zinc-400 cursor-not-allowed" : "hover:bg-zinc-100"
          }`}
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          ← Prev
        </button>

        <div className="text-sm text-zinc-600">
          Page <span className="font-semibold text-zinc-900">{page}</span> of{" "}
          <span className="font-semibold text-zinc-900">{totalPages}</span>
        </div>

        <button
          className={`rounded-xl px-3 py-2 font-semibold ${
            page >= totalPages ? "text-zinc-400 cursor-not-allowed" : "hover:bg-zinc-100"
          }`}
          disabled={page >= totalPages}
          onClick={() => setPage((p) => clamp(p + 1, 1, totalPages))}
        >
          Next →
        </button>
      </div>
    </main>
  );
}
