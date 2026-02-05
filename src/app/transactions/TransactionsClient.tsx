"use client";

import * as React from "react";

type Facet = { value: string; label: string };

type TxItem = {
  id: string;
  leagueId: string;
  season: number;
  type: string;
  typeLabel: string;
  createdAt: string;

  teams: string[];

  received: { rosterId: number; team: string; items: string[] }[];
  sent: { rosterId: number; team: string; items: string[] }[];

  added?: { rosterId: number; team: string; items: string[]; faab?: number }[];
  dropped?: { rosterId: number; team: string; items: string[] }[];
};

type ApiResp = {
  ok: boolean;
  rootLeagueId: string;
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
  error?: string;
};

type PlayerSearchResp = {
  ok: boolean;
  q: string;
  results: {
    id: string;
    fullName: string | null;
    position: string | null;
    team: string | null;
    status: string | null;
  }[];
  error?: string;
};

function buildQuery(params: Record<string, string | number | null | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

// Pick label parser: "2024 R1 (Owner pick Player Name)"
function renderMaybePickLabel(label: string) {
  const m = label.match(/^(\d{4}\sR\d+)\s\((.+?)\spick(?:\s(.+))?\)$/);
  if (!m) return <span>{label}</span>;

  const core = m[1];
  const owner = m[2];
  const drafted = (m[3] ?? "").trim();

  return (
    <span>
      {core}{" "}
      <span>
        ({owner} pick
        {drafted ? (
          <>
            {" "}
            <span className="italic text-zinc-500">{drafted}</span>
          </>
        ) : null}
        )
      </span>
    </span>
  );
}

function renderCommaList(items: string[]) {
  return (
    <>
      {items.map((it, idx) => (
        <React.Fragment key={`${it}-${idx}`}>
          {idx > 0 ? <span>, </span> : null}
          {renderMaybePickLabel(it)}
        </React.Fragment>
      ))}
    </>
  );
}

export default function TransactionsClient({ rootLeagueId }: { rootLeagueId: string }) {
  const [seasonSel, setSeasonSel] = React.useState<string[]>([]);
  const [typeSel, setTypeSel] = React.useState<string[]>([]);
  const [teamSel, setTeamSel] = React.useState<string[]>([]);

  const [page, setPage] = React.useState(1);
  const pageSize = 50;

  const [data, setData] = React.useState<ApiResp | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Player search
  const [playerQ, setPlayerQ] = React.useState("");
  const [playerOpen, setPlayerOpen] = React.useState(false);
  const [playerLoading, setPlayerLoading] = React.useState(false);
  const [playerResults, setPlayerResults] = React.useState<PlayerSearchResp["results"]>([]);
  const [playerErr, setPlayerErr] = React.useState<string | null>(null);

  // IMPORTANT: server-side player filter should use playerId, not name substring.
  // We keep a selectedPlayerId, and only filter the API when user picks from autocomplete.
  const [selectedPlayerId, setSelectedPlayerId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = buildQuery({
        leagueId: rootLeagueId,
        season: seasonSel.join(","),
        type: typeSel.join(","),
        team: teamSel.join(","),
        playerId: selectedPlayerId ?? "",
        page,
        pageSize,
      });

      const res = await fetch(`/api/transactions${qs}`, { cache: "no-store" });
      const json = (await res.json()) as ApiResp;

      if (!json.ok) {
        setErr(json.error ?? "Failed to load transactions.");
        setData(null);
      } else {
        setData(json);
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [rootLeagueId, seasonSel, typeSel, teamSel, page, selectedPlayerId]);

  React.useEffect(() => {
    load();
  }, [load]);

  // reset to page 1 when filters change
  React.useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonSel.join(","), typeSel.join(","), teamSel.join(","), selectedPlayerId ?? ""]);

  // Player autocomplete (>= 3 chars)
  React.useEffect(() => {
    let alive = true;

    async function run() {
      const q = playerQ.trim();
      if (q.length < 3) {
        setPlayerResults([]);
        setPlayerErr(null);
        return;
      }
      setPlayerLoading(true);
      setPlayerErr(null);
      try {
        const res = await fetch(`/api/players/search${buildQuery({ q })}`, { cache: "no-store" });
        const json = (await res.json()) as PlayerSearchResp;
        if (!alive) return;

        if (!json.ok) {
          setPlayerErr(json.error ?? "Search failed.");
          setPlayerResults([]);
        } else {
          setPlayerResults(json.results ?? []);
        }
      } catch (e: any) {
        if (!alive) return;
        setPlayerErr(e?.message ?? String(e));
        setPlayerResults([]);
      } finally {
        if (alive) setPlayerLoading(false);
      }
    }

    const t = setTimeout(run, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [playerQ]);

  function toggle(list: string[], v: string, setList: (x: string[]) => void) {
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }

  function clearAll() {
    setSeasonSel([]);
    setTypeSel([]);
    setTeamSel([]);
    setPlayerQ("");
    setSelectedPlayerId(null);
    setPlayerResults([]);
  }

  const totalPages = data?.totalPages ?? 1;

  const Pager = ({ className }: { className?: string }) => (
    <div
      className={`rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm text-sm text-zinc-600 flex flex-wrap gap-3 items-center justify-between ${
        className ?? ""
      }`}
    >
      <div>
        Showing{" "}
        <span className="font-semibold text-zinc-900">{data?.items?.length ?? 0}</span>{" "}
        {data ? (
          <>
            of <span className="font-semibold text-zinc-900">{data.total}</span>
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <button
          className={`rounded-xl px-3 py-2 font-semibold ${
            page <= 1 ? "text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
          }`}
          onClick={() => page > 1 && setPage(page - 1)}
          disabled={page <= 1}
        >
          ← Prev
        </button>

        <div className="text-zinc-600">
          Page <span className="font-semibold text-zinc-900">{page}</span> of{" "}
          <span className="font-semibold text-zinc-900">{totalPages}</span>
        </div>

        <button
          className={`rounded-xl px-3 py-2 font-semibold ${
            page >= totalPages ? "text-zinc-400" : "text-zinc-900 hover:bg-zinc-100"
          }`}
          onClick={() => page < totalPages && setPage(page + 1)}
          disabled={page >= totalPages}
        >
          Next →
        </button>
      </div>
    </div>
  );

  const CheckList = ({
    title,
    items,
    selected,
    onToggle,
  }: {
    title: string;
    items: Facet[];
    selected: string[];
    onToggle: (v: string) => void;
  }) => (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-zinc-900">{title}</div>
      <div className="max-h-48 overflow-auto rounded-2xl border border-zinc-200 bg-white p-2">
        {items.length === 0 ? (
          <div className="p-2 text-sm text-zinc-500">None</div>
        ) : (
          <ul className="space-y-1">
            {items.map((it) => (
              <li key={it.value}>
                <label className="flex items-center gap-2 rounded-xl px-2 py-1 hover:bg-zinc-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(it.value)}
                    onChange={() => onToggle(it.value)}
                  />
                  <span className="text-sm text-zinc-900">{it.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected.length > 0 && (
        <div className="text-xs text-zinc-500">Selected: {selected.length}</div>
      )}
    </div>
  );

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Transactions</h1>
            <p className="mt-1 text-sm text-zinc-600">
              {data ? (
                <>
                  Total in league history:{" "}
                  <span className="font-semibold text-zinc-900">{data.total}</span>
                </>
              ) : (
                <>Loading league history…</>
              )}
            </p>
          </div>

          <button
            className="rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
            onClick={clearAll}
          >
            Clear filters
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <CheckList
            title="Seasons"
            items={data?.facets?.seasons ?? []}
            selected={seasonSel}
            onToggle={(v) => toggle(seasonSel, v, setSeasonSel)}
          />
          <CheckList
            title="Types"
            items={data?.facets?.types ?? []}
            selected={typeSel}
            onToggle={(v) => toggle(typeSel, v, setTypeSel)}
          />
          <CheckList
            title="Teams"
            items={data?.facets?.teams ?? []}
            selected={teamSel}
            onToggle={(v) => toggle(teamSel, v, setTeamSel)}
          />
        </div>

        {/* Player search */}
        <div className="pt-2">
          <div className="text-sm font-semibold text-zinc-900">Player search</div>
          <div className="relative mt-2 max-w-xl">
            <input
              value={playerQ}
              onChange={(e) => {
                setPlayerQ(e.target.value);
                setPlayerOpen(true);
                setSelectedPlayerId(null); // typing clears selection until user chooses a suggestion
              }}
              onFocus={() => setPlayerOpen(true)}
              onBlur={() => setTimeout(() => setPlayerOpen(false), 150)}
              placeholder="Type 3+ chars (e.g. montgomery)…"
              className="w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none focus:border-zinc-900"
            />

            {playerOpen && playerQ.trim().length >= 3 && (
              <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg">
                {playerLoading && <div className="p-3 text-sm text-zinc-600">Searching…</div>}
                {playerErr && <div className="p-3 text-sm text-rose-700">{playerErr}</div>}
                {!playerLoading && !playerErr && playerResults.length === 0 && (
                  <div className="p-3 text-sm text-zinc-600">No matches.</div>
                )}

                {!playerLoading &&
                  !playerErr &&
                  playerResults.slice(0, 10).map((p) => {
                    const name = p.fullName ?? p.id;
                    const meta = [p.position, p.team].filter(Boolean).join(", ");
                    return (
                      <button
                        key={p.id}
                        className="w-full text-left px-4 py-3 hover:bg-zinc-50"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setPlayerQ(name);
                          setSelectedPlayerId(p.id);
                          setPlayerOpen(false);
                        }}
                      >
                        <div className="text-sm font-semibold text-zinc-900">{name}</div>
                        <div className="text-xs text-zinc-600">
                          {meta || "—"} {p.status ? `• ${p.status}` : ""}
                        </div>
                      </button>
                    );
                  })}
              </div>
            )}
          </div>

          <div className="mt-2 text-xs text-zinc-500">
            Select a suggestion to apply server-side filtering.
          </div>
        </div>
      </div>

      {err && (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {err}
        </div>
      )}
      {loading && (
        <div className="rounded-3xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
          Loading…
        </div>
      )}

      <Pager />

      <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-600">
            <tr>
              <th className="text-left p-3">Season</th>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">Type</th>
              <th className="text-left p-3">Teams</th>
              <th className="text-left p-3">Moves</th>
            </tr>
          </thead>

          <tbody>
            {(data?.items ?? []).map((t) => (
              <tr key={t.id} className="border-t align-top">
                <td className="p-3 whitespace-nowrap">{t.season}</td>
                <td className="p-3 whitespace-nowrap">{fmtDate(t.createdAt)}</td>
                <td className="p-3 whitespace-nowrap">{t.typeLabel}</td>
                <td className="p-3 whitespace-nowrap">{t.teams.join(" ↔ ") || "—"}</td>
                <td className="p-3">
                  {t.type === "trade" ? (
                    <div className="space-y-2">
                      {t.received.map((r) => (
                        <div key={`recv-${r.rosterId}`} className="leading-snug">
                          <div className="font-semibold text-zinc-900">{r.team} received</div>
                          <div className="text-zinc-700">{renderCommaList(r.items)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {t.added && t.added.length > 0 && (
                        <div className="space-y-1">
                          {t.added.map((a) => (
                            <div key={`add-${a.rosterId}`} className="text-emerald-800">
                              <span className="font-semibold">{a.team}</span>: Added{" "}
                              {renderCommaList(a.items)}
                              {typeof a.faab === "number" && a.faab > 0 ? (
                                <span className="ml-2 text-emerald-900 font-semibold">
                                  (FAAB ${a.faab})
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}

                      {t.dropped && t.dropped.length > 0 && (
                        <div className="space-y-1">
                          {t.dropped.map((d) => (
                            <div key={`drop-${d.rosterId}`} className="text-rose-800">
                              <span className="font-semibold">{d.team}</span>: Dropped{" "}
                              {renderCommaList(d.items)}
                            </div>
                          ))}
                        </div>
                      )}

                      {(!t.added || t.added.length === 0) &&
                        (!t.dropped || t.dropped.length === 0) && (
                          <span className="text-zinc-400">—</span>
                        )}
                    </div>
                  )}
                </td>
              </tr>
            ))}

            {(data?.items?.length ?? 0) === 0 && (
              <tr>
                <td className="p-6 text-zinc-600" colSpan={5}>
                  No transactions match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager className="mb-8" />
    </main>
  );
}
