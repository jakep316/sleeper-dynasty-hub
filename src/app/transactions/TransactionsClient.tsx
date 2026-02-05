"use client";

import { useEffect, useMemo, useState } from "react";

type TxAsset = {
  id: string;
  kind: string;
  playerId?: string | null;
  fromRosterId?: number | null;
  toRosterId?: number | null;
  pickSeason?: number | null;
  pickRound?: number | null;
  faabAmount?: number | null;
};

type Tx = {
  id: string;
  leagueId: string;
  season: number;
  week: number;
  type: string;
  createdAt: string;
  teams: string;
  moves: string;
  assets: TxAsset[];
};

type ApiResponse = {
  ok: boolean;
  items: Tx[];
  total: number;
  error?: string;
};

type Props = {
  leagueId: string;
};

const PAGE_SIZE = 50;

function prettyType(type: string) {
  return type
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export default function TransactionsClient({ leagueId }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [season, setSeason] = useState("all");
  const [team, setTeam] = useState("all");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    async function load() {
      setLoading(true);

      const params = new URLSearchParams();
      if (season !== "all") params.set("season", season);
      if (team !== "all") params.set("team", team);
      if (type !== "all") params.set("type", type);
      params.set("page", String(page));

      const res = await fetch(`/api/transactions?${params.toString()}`);
      const json = await res.json();

      setData(json);
      setLoading(false);
    }

    load();
  }, [season, team, type, page]);

  const seasons = useMemo(() => {
    if (!data?.items) return [];
    return [...new Set(data.items.map((t) => t.season))].sort((a, b) => b - a);
  }, [data]);

  const types = useMemo(() => {
    if (!data?.items) return [];
    return [...new Set(data.items.map((t) => t.type))].sort();
  }, [data]);

  const teams = useMemo(() => {
    if (!data?.items) return [];
    return [...new Set(data.items.map((t) => t.teams))].sort();
  }, [data]);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
        <select
          value={season}
          onChange={(e) => {
            setSeason(e.target.value);
            setPage(1);
          }}
          className="rounded-xl border px-3 py-2"
        >
          <option value="all">All Seasons</option>
          {seasons.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>

        <select
          value={team}
          onChange={(e) => {
            setTeam(e.target.value);
            setPage(1);
          }}
          className="rounded-xl border px-3 py-2"
        >
          <option value="all">All Teams</option>
          {teams.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>

        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
          className="rounded-xl border px-3 py-2"
        >
          <option value="all">All Types</option>
          {types.map((t) => (
            <option key={t}>{prettyType(t)}</option>
          ))}
        </select>
      </div>

      {/* Pagination Top */}
      <Pager page={page} setPage={setPage} total={data?.total ?? 0} />

      {/* Table */}
      <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-600">
            <tr>
              <th className="p-3 text-left">Season</th>
              <th className="p-3 text-left">Week</th>
              <th className="p-3 text-left">Date</th>
              <th className="p-3 text-left">Type</th>
              <th className="p-3 text-left">Teams</th>
              <th className="p-3 text-left">Moves</th>
            </tr>
          </thead>

          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="p-6 text-zinc-500">
                  Loading…
                </td>
              </tr>
            )}

            {data?.items?.map((t) => (
              <tr key={t.id} className="border-t align-top">
                <td className="p-3">{t.season}</td>
                <td className="p-3">{t.week}</td>
                <td className="p-3">
                  {new Date(t.createdAt).toLocaleDateString()}
                </td>
                <td className="p-3">{prettyType(t.type)}</td>
                <td className="p-3">{t.teams}</td>
                <td className="p-3 whitespace-pre-wrap">{t.moves}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination Bottom */}
      <Pager page={page} setPage={setPage} total={data?.total ?? 0} />

      {/* Error */}
      {data?.ok === false && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {data.error ?? "Unknown error"}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- Pager ----------------------------- */

function Pager({
  page,
  setPage,
  total,
}: {
  page: number;
  setPage: (p: number) => void;
  total: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex items-center justify-between rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm">
      <button
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
        className="rounded-xl border px-3 py-1 disabled:opacity-40"
      >
        ← Prev
      </button>

      <span>
        Page {page} / {totalPages}
      </span>

      <button
        disabled={page >= totalPages}
        onClick={() => setPage(page + 1)}
        className="rounded-xl border px-3 py-1 disabled:opacity-40"
      >
        Next →
      </button>
    </div>
  );
}
