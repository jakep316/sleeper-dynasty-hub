"use client";

import { useEffect, useMemo, useState } from "react";

type Option = { value: string; label: string };

type ApiTradeLine = {
  rosterId: number;
  team: string;
  received: string[];
  sent: string[];
};

type ApiItem =
  | {
      id: string;
      leagueId: string;
      season: number;
      week: number;
      type: string;
      typeLabel: string;
      date: string;
      teamsLabel: string;
      moves: { kind: "trade"; lines: ApiTradeLine[] };
    }
  | {
      id: string;
      leagueId: string;
      season: number;
      week: number;
      type: string;
      typeLabel: string;
      date: string;
      teamsLabel: string;
      moves: { kind: "simple"; adds: string[]; drops: string[] };
    };

type ApiResponse = {
  ok: boolean;
  error?: string;
  rootLeagueId: string;
  chainLeagueIds: string[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  items: ApiItem[];
};

type Props = {
  rootLeagueId: string;
  seasons: Option[];
  types: Option[];
  teams: Option[];
};

function cls(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function Pager({
  page,
  totalPages,
  loading,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm text-sm text-zinc-600 flex flex-wrap gap-3 items-center justify-between">
      <div>
        Page <span className="font-semibold text-zinc-900">{page}</span> of{" "}
        <span className="font-semibold text-zinc-900">{totalPages}</span>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onPrev}
          disabled={page <= 1 || loading}
          className={cls(
            "rounded-xl px-3 py-2 font-semibold",
            page <= 1 || loading
              ? "text-zinc-400 border border-zinc-200"
              : "text-zinc-900 border border-zinc-200 hover:bg-zinc-50"
          )}
        >
          ← Prev
        </button>

        <button
          type="button"
          onClick={onNext}
          disabled={page >= totalPages || loading}
          className={cls(
            "rounded-xl px-3 py-2 font-semibold",
            page >= totalPages || loading
              ? "text-zinc-400 border border-zinc-200"
              : "text-zinc-900 border border-zinc-200 hover:bg-zinc-50"
          )}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

export default function TransactionsClient({ rootLeagueId, seasons, types, teams }: Props) {
  const [selectedSeasons, setSelectedSeasons] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);

  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [selectedSeasons.join(","), selectedTypes.join(","), selectedTeams.join(",")]);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("rootLeagueId", rootLeagueId);
    sp.set("page", String(page));
    sp.set("pageSize", "50");

    if (selectedSeasons.length) sp.set("seasons", selectedSeasons.join(","));
    if (selectedTypes.length) sp.set("types", selectedTypes.join(","));
    if (selectedTeams.length) sp.set("teams", selectedTeams.join(","));

    return sp.toString();
  }, [rootLeagueId, page, selectedSeasons, selectedTypes, selectedTeams]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/transactions?${query}`, { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function toggle(list: string[], v: string) {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  function resetAll() {
    setSelectedSeasons([]);
    setSelectedTypes([]);
    setSelectedTeams([]);
    setPage(1);
  }

  const total = data?.totalCount ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const items = data?.items ?? [];

  const onPrev = () => setPage((p) => Math.max(1, p - 1));
  const onNext = () => setPage((p) => Math.min(totalPages, p + 1));

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Transactions</h1>
            <p className="mt-1 text-sm text-zinc-600">
              {loading ? (
                <span>Loading…</span>
              ) : (
                <>
                  Showing <span className="font-semibold text-zinc-900">{items.length}</span> rows •{" "}
                  <span className="font-semibold text-zinc-900">{total}</span> total
                </>
              )}
            </p>
          </div>

          <button
            onClick={resetAll}
            className="rounded-xl px-4 py-2 text-sm font-semibold border border-zinc-200 hover:bg-zinc-50"
            type="button"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold mb-2">Seasons</div>
          <div className="max-h-56 overflow-auto space-y-2">
            {seasons.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedSeasons.includes(o.value)}
                  onChange={() => setSelectedSeasons((s) => toggle(s, o.value))}
                />
                <span>{o.label}</span>
              </label>
            ))}
            {seasons.length === 0 && <div className="text-sm text-zinc-500">No seasons found.</div>}
          </div>
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold mb-2">Types</div>
          <div className="max-h-56 overflow-auto space-y-2">
            {types.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedTypes.includes(o.value)}
                  onChange={() => setSelectedTypes((s) => toggle(s, o.value))}
                />
                <span>{o.label}</span>
              </label>
            ))}
            {types.length === 0 && <div className="text-sm text-zinc-500">No types found.</div>}
          </div>
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold mb-2">Teams</div>
          <div className="max-h-56 overflow-auto space-y-2">
            {teams.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedTeams.includes(o.value)}
                  onChange={() => setSelectedTeams((s) => toggle(s, o.value))}
                />
                <span>{o.label}</span>
              </label>
            ))}
            {teams.length === 0 && <div className="text-sm text-zinc-500">No teams found.</div>}
          </div>
        </div>
      </div>

      {/* Pager (TOP) */}
      <Pager page={page} totalPages={totalPages} loading={loading} onPrev={onPrev} onNext={onNext} />

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
              <th className="text-left p-3">Moves</th>
            </tr>
          </thead>

          <tbody>
            {items.map((t) => (
              <tr key={t.id} className="border-t align-top">
                <td className="p-3 whitespace-nowrap">{t.season}</td>
                <td className="p-3 whitespace-nowrap">{t.week}</td>
                <td className="p-3 whitespace-nowrap">{new Date(t.date).toLocaleDateString()}</td>
                <td className="p-3 whitespace-nowrap">{t.typeLabel}</td>
                <td className="p-3 whitespace-nowrap">{t.teamsLabel}</td>
                <td className="p-3">
                  {t.moves.kind === "simple" ? (
                    <div className="space-y-1">
                      {t.moves.adds.length > 0 && (
                        <div className="text-emerald-700">Added: {t.moves.adds.join(", ")}</div>
                      )}
                      {t.moves.drops.length > 0 && (
                        <div className="text-rose-700">Dropped: {t.moves.drops.join(", ")}</div>
                      )}
                      {t.moves.adds.length === 0 && t.moves.drops.length === 0 && (
                        <span className="text-zinc-400">—</span>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {t.moves.lines.map((line) => (
                        <div key={line.rosterId} className="leading-snug">
                          <div className="font-semibold text-zinc-900">{line.team}</div>
                          <div className="text-zinc-700">
                            <span className="font-semibold">Received:</span>{" "}
                            {line.received.length ? line.received.join(", ") : "—"}
                          </div>
                          <div className="text-zinc-700">
                            <span className="font-semibold">Sent:</span>{" "}
                            {line.sent.length ? line.sent.join(", ") : "—"}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}

            {!loading && items.length === 0 && (
              <tr>
                <td className="p-6 text-zinc-600" colSpan={6}>
                  No transactions match those filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pager (BOTTOM) */}
      <Pager page={page} totalPages={totalPages} loading={loading} onPrev={onPrev} onNext={onNext} />

      {data?.ok === false && (
        <div className="rounded-2xl border border-rose-200 bg-ro
