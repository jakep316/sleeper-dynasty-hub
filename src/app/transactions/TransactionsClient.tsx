"use client";

import { useEffect, useMemo, useState } from "react";

type Option = { value: string; label: string };

type ApiItem = {
  id: string;
  leagueId: string;
  season: number;
  week: number;
  type: string;
  typeLabel: string;
  status: string;
  createdAt: string;
  teams: string;
  moves:
    | { adds: string[]; drops: string[]; faab: { rosterId: number; team: string; amount: number }[] }
    | { rosterId: number; team: string; received: string[] }[];
};

type ApiResponse =
  | {
      ok: true;
      leagueId: string;
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
      items: ApiItem[];
    }
  | { ok: false; error: string };

type Props = {
  leagueId: string;
  seasons: Option[];
  types: Option[];
  teams: Option[];
};

const PAGE_SIZE = 50;

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function TransactionsClient(props: Props) {
  // ✅ Defensive defaults to prevent undefined.map() crashes
  const leagueId = props.leagueId;
  const seasons = props.seasons ?? [];
  const types = props.types ?? [];
  const teams = props.teams ?? [];

  const [page, setPage] = useState(1);

  // Filters (client-side)
  const [seasonValues, setSeasonValues] = useState<string[]>([]);
  const [typeValues, setTypeValues] = useState<string[]>([]);
  const [teamValue, setTeamValue] = useState<string>("all");

  // Player autocomplete
  const [playerQ, setPlayerQ] = useState("");
  const [playerSuggestions, setPlayerSuggestions] = useState<Option[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>("");

  // Data
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // fetch page of transactions (server filtered by leagueId only; we filter client-side)
  async function load() {
    setLoading(true);
    setData(null);

    try {
      const url = `/api/transactions?leagueId=${encodeURIComponent(leagueId)}&page=${page}&pageSize=${PAGE_SIZE}`;
      const res = await fetch(url, { cache: "no-store" });

      // Robust parse (prevents json() throwing on HTML error pages)
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { ok: false, error: text || `HTTP ${res.status}` };
      }

      if (!res.ok) {
        setData({ ok: false, error: json?.error ?? `HTTP ${res.status}` });
      } else {
        setData(json as ApiResponse);
      }
    } catch (e: any) {
      setData({ ok: false, error: e?.message ?? String(e) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId, page]);

  // Player suggestions (only after 3 chars)
  useEffect(() => {
    const q = playerQ.trim();
    if (q.length < 3) {
      setPlayerSuggestions([]);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/players/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;

        const rows: any[] = Array.isArray(json?.results) ? json.results : [];
        setPlayerSuggestions(
          rows.map((r) => ({
            value: String(r.id),
            label: `${r.fullName ?? r.id}${r.position ? ` (${r.position}${r.team ? `, ${r.team}` : ""})` : ""}`,
          }))
        );
      } catch {
        if (!cancelled) setPlayerSuggestions([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [playerQ]);

  const items: ApiItem[] = useMemo(() => {
    if (!data || data.ok !== true) return [];
    return Array.isArray(data.items) ? data.items : [];
  }, [data]);

  const filtered = useMemo(() => {
    let out = items;

    // season multi-select
    if (seasonValues.length > 0) {
      const set = new Set(seasonValues.map(Number));
      out = out.filter((t) => set.has(t.season));
    }

    // type multi-select
    if (typeValues.length > 0) {
      const set = new Set(typeValues);
      out = out.filter((t) => set.has(t.type));
    }

    // team filter (roster label is baked into "teams" string right now)
    if (teamValue !== "all") {
      const teamLabel = teams.find((t) => t.value === teamValue)?.label;
      if (teamLabel) out = out.filter((t) => (t.teams ?? "").includes(teamLabel));
    }

    // player filter (match in moves text)
    if (selectedPlayerId) {
      out = out.filter((t) => {
        const m: any = t.moves;

        // trades: array of received lists
        if (Array.isArray(m)) {
          return m.some((x) => (x.received ?? []).join(" ").includes(selectedPlayerId));
        }

        // non-trades: adds/drops
        const adds = (m?.adds ?? []).join(" ");
        const drops = (m?.drops ?? []).join(" ");
        return adds.includes(selectedPlayerId) || drops.includes(selectedPlayerId);
      });
    }

    return out;
  }, [items, seasonValues, typeValues, teamValue, teams, selectedPlayerId]);

  const totalPages = data && data.ok === true ? data.totalPages : 1;

  function ToggleChip({
    label,
    active,
    onClick,
  }: {
    label: string;
    active: boolean;
    onClick: () => void;
  }) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`rounded-xl border px-3 py-2 text-sm font-semibold ${
          active
            ? "border-zinc-900 bg-zinc-900 text-white"
            : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50"
        }`}
      >
        {label}
      </button>
    );
  }

  const seasonValueSet = new Set(seasonValues);
  const typeValueSet = new Set(typeValues);

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold">Transactions</h1>
        <p className="mt-1 text-sm text-zinc-600">
          League: <span className="font-mono text-zinc-900">{leagueId}</span>
        </p>
      </div>

      {/* Filters */}
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="text-sm text-zinc-600">
            {data?.ok === true ? (
              <>
                Loaded <span className="font-semibold text-zinc-900">{items.length}</span> items (page{" "}
                <span className="font-semibold text-zinc-900">{data.page}</span> of{" "}
                <span className="font-semibold text-zinc-900">{data.totalPages}</span>)
              </>
            ) : (
              <>Loaded <span className="font-semibold text-zinc-900">0</span> items</>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                page <= 1 ? "text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
              }`}
              disabled={page <= 1}
            >
              ← Prev
            </button>

            <div className="text-sm text-zinc-600">
              Page <span className="font-semibold text-zinc-900">{page}</span>
            </div>

            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                page >= totalPages ? "text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
              }`}
              disabled={page >= totalPages}
            >
              Next →
            </button>
          </div>
        </div>

        {/* Season chips */}
        <div>
          <div className="text-xs font-semibold text-zinc-500 mb-2">Seasons</div>
          <div className="flex flex-wrap gap-2">
            {(seasons ?? []).map((s) => (
              <ToggleChip
                key={s.value}
                label={s.label}
                active={seasonValueSet.has(s.value)}
                onClick={() => {
                  setPage(1);
                  setSeasonValues((prev) =>
                    prev.includes(s.value) ? prev.filter((x) => x !== s.value) : [...prev, s.value]
                  );
                }}
              />
            ))}
            {seasons.length === 0 && <div className="text-sm text-zinc-500">No seasons available.</div>}
          </div>
        </div>

        {/* Type chips */}
        <div>
          <div className="text-xs font-semibold text-zinc-500 mb-2">Types</div>
          <div className="flex flex-wrap gap-2">
            {(types ?? []).map((t) => (
              <ToggleChip
                key={t.value}
                label={t.label}
                active={typeValueSet.has(t.value)}
                onClick={() => {
                  setPage(1);
                  setTypeValues((prev) =>
                    prev.includes(t.value) ? prev.filter((x) => x !== t.value) : [...prev, t.value]
                  );
                }}
              />
            ))}
            {types.length === 0 && <div className="text-sm text-zinc-500">No types available.</div>}
          </div>
        </div>

        {/* Team dropdown */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="text-xs font-semibold text-zinc-500">Team</div>
          <select
            className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={teamValue}
            onChange={(e) => {
              setPage(1);
              setTeamValue(e.target.value);
            }}
          >
            <option value="all">All teams</option>
            {(teams ?? []).map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {/* Player autocomplete */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-zinc-500">Player (type 3+ letters)</div>
          <div className="relative">
            <input
              className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
              value={playerQ}
              onChange={(e) => {
                const v = e.target.value;
                setPlayerQ(v);
                if (v.trim().length < 3) setSelectedPlayerId("");
              }}
              placeholder="Start typing a player name…"
            />

            {(playerSuggestions ?? []).length > 0 && playerQ.trim().length >= 3 && (
              <div className="absolute z-20 mt-2 w-full rounded-2xl border border-zinc-200 bg-white shadow-lg overflow-hidden">
                {(playerSuggestions ?? []).slice(0, 10).map((sug) => (
                  <button
                    key={sug.value}
                    type="button"
                    onClick={() => {
                      setSelectedPlayerId(sug.value);
                      setPlayerQ(sug.label);
                      setPlayerSuggestions([]);
                      setPage(1);
                    }}
                    className="block w-full text-left px-3 py-2 text-sm hover:bg-zinc-50"
                  >
                    {sug.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedPlayerId && (
            <div className="flex items-center gap-2">
              <div className="text-sm text-zinc-600">
                Filtering by player ID: <span className="font-mono text-zinc-900">{selectedPlayerId}</span>
              </div>
              <button
                type="button"
                className="rounded-xl border border-zinc-200 px-3 py-2 text-sm font-semibold hover:bg-zinc-50"
                onClick={() => {
                  setSelectedPlayerId("");
                  setPlayerQ("");
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Load errors */}
        {data?.ok === false && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
            {data.error}
          </div>
        )}

        {loading && (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700">
            Loading…
          </div>
        )}
      </div>

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
            {(filtered ?? []).map((t) => (
              <tr key={t.id} className="border-t align-top">
                <td className="p-3 whitespace-nowrap">{t.season}</td>
                <td className="p-3 whitespace-nowrap">{t.week}</td>
                <td className="p-3 whitespace-nowrap">{formatDate(t.createdAt)}</td>
                <td className="p-3 whitespace-nowrap">{t.typeLabel}</td>
                <td className="p-3 whitespace-nowrap">{t.teams}</td>
                <td className="p-3">
                  {/* trades */}
                  {Array.isArray(t.moves) ? (
                    <div className="space-y-2">
                      {t.moves.map((m) => (
                        <div key={m.rosterId}>
                          <div className="font-semibold text-zinc-900">{m.team} received</div>
                          <div className="text-zinc-700">{(m.received ?? []).join(", ") || "—"}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {(t.moves?.adds ?? []).length > 0 && (
                        <div className="text-emerald-700">Added: {(t.moves.adds ?? []).join(", ")}</div>
                      )}
                      {(t.moves?.drops ?? []).length > 0 && (
                        <div className="text-rose-700">Dropped: {(t.moves.drops ?? []).join(", ")}</div>
                      )}
                      {(t.moves?.faab ?? []).length > 0 && (
                        <div className="text-zinc-700">
                          FAAB:{" "}
                          {t.moves.faab
                            .map((x) => `${x.team} $${x.amount}`)
                            .join(" • ")}
                        </div>
                      )}
                      {(!t.moves?.adds?.length && !t.moves?.drops?.length && !t.moves?.faab?.length) && (
                        <span className="text-zinc-400">—</span>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}

            {filtered.length === 0 && (
              <tr>
                <td className="p-6 text-zinc-600" colSpan={6}>
                  No transactions found (try removing filters or syncing more seasons).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom pagination (like you wanted) */}
      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm text-sm text-zinc-600 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className={`rounded-xl px-3 py-2 font-semibold ${
            page <= 1 ? "text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
          }`}
          disabled={page <= 1}
        >
          ← Prev
        </button>

        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          className={`rounded-xl px-3 py-2 font-semibold ${
            page >= totalPages ? "text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
          }`}
          disabled={page >= totalPages}
        >
          Next →
        </button>
      </div>
    </main>
  );
}
