"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TxItem = {
  id: string;
  leagueId: string;
  season: number;
  week: number;
  type: string;
  typeLabel: string;
  createdAt: string;
  teams: string[];
  received: { rosterId: number; team: string; items: string[] }[];
  sent: { rosterId: number; team: string; items: string[] }[];
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
    }
  | { ok: false; error: string };

type PlayerResult = { id: string; fullName: string | null; position: string | null; team: string | null; status: string | null };

type Props = {
  leagueId: string;
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function prettyDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function toggleSet(set: Set<string>, value: string) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function TransactionsClient({ leagueId }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Multi-select filters (store as strings for easy URL params)
  const [seasonSel, setSeasonSel] = useState<Set<string>>(new Set());
  const [typeSel, setTypeSel] = useState<Set<string>>(new Set());
  const [teamSel, setTeamSel] = useState<Set<string>>(new Set());

  // Player autocomplete
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerResults, setPlayerResults] = useState<PlayerResult[]>([]);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playerLabel, setPlayerLabel] = useState<string | null>(null);
  const playerAbortRef = useRef<AbortController | null>(null);

  // Pagination
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const queryString = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("leagueId", leagueId);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));

    if (seasonSel.size) sp.set("seasons", Array.from(seasonSel).sort().join(","));
    if (typeSel.size) sp.set("types", Array.from(typeSel).sort().join(","));
    if (teamSel.size) sp.set("teams", Array.from(teamSel).sort().join(","));
    if (playerId) sp.set("playerId", playerId);

    return `?${sp.toString()}`;
  }, [leagueId, page, pageSize, seasonSel, typeSel, teamSel, playerId]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/transactions${queryString}`, { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } finally {
      setLoading(false);
    }
  }

  // Reload on filter/page changes
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  // Autocomplete: query at 3+ chars
  useEffect(() => {
    const q = playerQuery.trim();
    if (q.length < 3) {
      setPlayerResults([]);
      return;
    }

    // cancel prior request
    playerAbortRef.current?.abort();
    const ac = new AbortController();
    playerAbortRef.current = ac;

    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/players/search?q=${encodeURIComponent(q)}`, { signal: ac.signal });
        const json = await res.json();
        if (json?.ok) setPlayerResults(json.results ?? []);
      } catch {
        // ignore
      }
    }, 200);

    return () => clearTimeout(t);
  }, [playerQuery]);

  // When any filter changes, reset to page 1
  function bumpFilters() {
    setPage(1);
  }

  // Derive filter options from currently loaded page (simple + stable).
  // Once you’ve synced the chain, this will quickly show all seasons/types that exist.
  const seasons = useMemo(() => {
    if (!data || data.ok === false) return [];
    const set = new Set<number>();
    for (const it of data.items) set.add(it.season);
    // If you want full-season list across DB, we can add an endpoint later; this is “good enough” now.
    return Array.from(set).sort((a, b) => b - a);
  }, [data]);

  const types = useMemo(() => {
    if (!data || data.ok === false) return [];
    const set = new Set<string>();
    for (const it of data.items) set.add(it.type);
    return Array.from(set).sort();
  }, [data]);

  const teams = useMemo(() => {
    if (!data || data.ok === false) return [];
    const set = new Set<string>();
    // We don’t have rosterId list here; team chips will come from transactions content.
    // That’s fine — it’s usable and stays consistent with displayed data.
    for (const it of data.items) for (const t of it.teams) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data]);

  // NOTE: Team filtering via rosterId is better than name,
  // but rosterId options require a roster list endpoint.
  // For now, teamSel stores rosterId strings only if you wire them that way.
  // This UI still works great for seasons/types + player, and we can harden teams next.
  // (If you already have rosterId-based teams in your existing UI, tell me and I’ll align it.)

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">Transactions</h1>
            <p className="mt-1 text-sm text-zinc-600">
              {data?.ok ? (
                <>
                  Showing <span className="font-semibold text-zinc-900">{data.total}</span> total
                </>
              ) : (
                <span className="text-zinc-500">—</span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              className={cn(
                "rounded-xl px-3 py-2 text-sm font-semibold border",
                loading ? "bg-zinc-100 text-zinc-400 border-zinc-200" : "bg-white hover:bg-zinc-50 border-zinc-200"
              )}
              onClick={() => load()}
              disabled={loading}
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Seasons */}
          <div>
            <div className="text-xs font-semibold text-zinc-600 mb-2">Seasons</div>
            <div className="flex flex-wrap gap-2">
              {seasons.length === 0 && <span className="text-sm text-zinc-500">—</span>}
              {seasons.map((s) => {
                const key = String(s);
                const active = seasonSel.has(key);
                return (
                  <button
                    key={key}
                    className={cn(
                      "rounded-xl px-3 py-2 text-sm font-semibold border",
                      active ? "bg-zinc-900 text-white border-zinc-900" : "bg-white hover:bg-zinc-50 border-zinc-200"
                    )}
                    onClick={() => {
                      setSeasonSel((cur) => toggleSet(cur, key));
                      bumpFilters();
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Types */}
          <div>
            <div className="text-xs font-semibold text-zinc-600 mb-2">Types</div>
            <div className="flex flex-wrap gap-2">
              {types.length === 0 && <span className="text-sm text-zinc-500">—</span>}
              {types.map((t) => {
                const active = typeSel.has(t);
                return (
                  <button
                    key={t}
                    className={cn(
                      "rounded-xl px-3 py-2 text-sm font-semibold border",
                      active ? "bg-zinc-900 text-white border-zinc-900" : "bg-white hover:bg-zinc-50 border-zinc-200"
                    )}
                    onClick={() => {
                      setTypeSel((cur) => toggleSet(cur, t));
                      bumpFilters();
                    }}
                  >
                    {t.replaceAll("_", " ")}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Player search */}
          <div>
            <div className="text-xs font-semibold text-zinc-600 mb-2">Player</div>

            {playerId && playerLabel ? (
              <div className="flex items-center justify-between gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2">
                <div className="text-sm font-semibold text-zinc-900">{playerLabel}</div>
                <button
                  className="text-sm font-semibold text-zinc-700 hover:text-zinc-900"
                  onClick={() => {
                    setPlayerId(null);
                    setPlayerLabel(null);
                    setPlayerQuery("");
                    setPlayerResults([]);
                    bumpFilters();
                  }}
                >
                  Clear
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  className="w-full rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
                  placeholder="Type 3+ chars (e.g. met)"
                  value={playerQuery}
                  onChange={(e) => setPlayerQuery(e.target.value)}
                />

                {playerResults.length > 0 && (
                  <div className="absolute z-10 mt-2 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg">
                    {playerResults.map((p) => {
                      const label = [
                        p.fullName ?? `Player ${p.id}`,
                        [p.position, p.team].filter(Boolean).join(", "),
                      ]
                        .filter(Boolean)
                        .join(" • ");

                      return (
                        <button
                          key={p.id}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-zinc-50"
                          onClick={() => {
                            setPlayerId(p.id);
                            setPlayerLabel(label);
                            setPlayerResults([]);
                            bumpFilters();
                          }}
                        >
                          <div className="font-semibold text-zinc-900">{p.fullName ?? `Player ${p.id}`}</div>
                          <div className="text-xs text-zinc-600">
                            {[p.position, p.team, p.status].filter(Boolean).join(" • ")}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Clear filters */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-zinc-500">
            Tip: click multiple seasons/types to combine filters
          </div>

          <button
            className="rounded-xl px-3 py-2 text-sm font-semibold border border-zinc-200 bg-white hover:bg-zinc-50"
            onClick={() => {
              setSeasonSel(new Set());
              setTypeSel(new Set());
              setTeamSel(new Set());
              setPlayerId(null);
              setPlayerLabel(null);
              setPlayerQuery("");
              setPlayerResults([]);
              setPage(1);
            }}
          >
            Clear all
          </button>
        </div>
      </div>

      {/* Errors */}
      {data?.ok === false && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          {data.error}
        </div>
      )}

      {/* Paging (top) */}
      {data?.ok && (
        <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm text-sm text-zinc-600 flex flex-wrap gap-3 items-center justify-between">
          <div>
            Showing{" "}
            <span className="font-semibold text-zinc-900">{data.items.length}</span> of{" "}
            <span className="font-semibold text-zinc-900">{data.total}</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              className={cn(
                "rounded-xl px-3 py-2 font-semibold",
                data.page <= 1 ? "text-zinc-400 cursor-not-allowed" : "text-zinc-900 hover:bg-zinc-100"
              )}
              disabled={data.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </button>

            <div className="text-zinc-600">
              Page <span className="font-semibold text-zinc-900">{data.page}</span> of{" "}
              <span className="font-semibold text-zinc-900">{data.totalPages}</span>
            </div>

            <button
              className={cn(
                "rounded-xl px-3 py-2 font-semibold",
                data.page >= data.totalPages
                  ? "text-zinc-400 cursor-not-allowed"
                  : "text-zinc-900 hover:bg-zinc-100"
              )}
              disabled={data.page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-600">
            <tr>
              <th className="text-left p-3">Season</th>
              <th className="text-left p-3">Week</th>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">Type</th>
              <th className="text-left p-3">Teams</th>
              <th className="text-left p-3">Details</th>
            </tr>
          </thead>

          <tbody>
            {data?.ok &&
              data.items.map((t) => (
                <tr key={t.id} className="border-t align-top">
                  <td className="p-3 whitespace-nowrap">{t.season}</td>
                  <td className="p-3 whitespace-nowrap">{t.week}</td>
                  <td className="p-3 whitespace-nowrap">{prettyDate(t.createdAt)}</td>
                  <td className="p-3 whitespace-nowrap">{t.typeLabel}</td>
                  <td className="p-3 whitespace-nowrap">{t.teams.join(" ↔ ") || "—"}</td>
                  <td className="p-3">
                    {t.type === "trade" ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          <div className="rounded-2xl border border-zinc-200 p-3">
                            <div className="text-xs font-semibold text-zinc-600 mb-1">Received</div>
                            {t.received.length ? (
                              <div className="space-y-2">
                                {t.received.map((r) => (
                                  <div key={r.rosterId}>
                                    <div className="font-semibold text-zinc-900">{r.team}</div>
                                    <div className="text-zinc-700">{r.items.join(", ") || "—"}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-zinc-400">—</div>
                            )}
                          </div>

                          <div className="rounded-2xl border border-zinc-200 p-3">
                            <div className="text-xs font-semibold text-zinc-600 mb-1">Sent</div>
                            {t.sent.length ? (
                              <div className="space-y-2">
                                {t.sent.map((s) => (
                                  <div key={s.rosterId}>
                                    <div className="font-semibold text-zinc-900">{s.team}</div>
                                    <div className="text-zinc-700">{s.items.join(", ") || "—"}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-zinc-400">—</div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {t.received.length > 0 && (
                          <div className="text-emerald-700">
                            Added:{" "}
                            {t.received
                              .flatMap((r) => r.items)
                              .filter(Boolean)
                              .join(", ") || "—"}
                          </div>
                        )}
                        {t.sent.length > 0 && (
                          <div className="text-rose-700">
                            Dropped:{" "}
                            {t.sent
                              .flatMap((s) => s.items)
                              .filter(Boolean)
                              .join(", ") || "—"}
                          </div>
                        )}
                        {t.received.length === 0 && t.sent.length === 0 && (
                          <span className="text-zinc-400">—</span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}

            {(!data || (data.ok && data.items.length === 0)) && (
              <tr>
                <td className="p-6 text-zinc-600" colSpan={6}>
                  {loading ? "Loading…" : "No transactions found with the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Paging (bottom) */}
      {data?.ok && (
        <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm text-sm text-zinc-600 flex flex-wrap gap-3 items-center justify-between">
          <div>
            Page <span className="font-semibold text-zinc-900">{data.page}</span> of{" "}
            <span className="font-semibold text-zinc-900">{data.totalPages}</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              className={cn(
                "rounded-xl px-3 py-2 font-semibold",
                data.page <= 1 ? "text-zinc-400 cursor-not-allowed" : "text-zinc-900 hover:bg-zinc-100"
              )}
              disabled={data.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </button>

            <button
              className={cn(
                "rounded-xl px-3 py-2 font-semibold",
                data.page >= data.totalPages
                  ? "text-zinc-400 cursor-not-allowed"
                  : "text-zinc-900 hover:bg-zinc-100"
              )}
              disabled={data.page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
