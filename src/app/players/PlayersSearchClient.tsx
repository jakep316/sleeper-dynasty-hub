"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Result = {
  id: string;
  fullName: string | null;
  position: string | null;
  team: string | null;
  status: string | null;
};

function clsx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export default function PlayersSearchClient() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const abortRef = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const canSearch = q.trim().length >= 3;

  const hint = useMemo(() => {
    if (!q.trim()) return "Search by player name (e.g. 'metch' or 'jonnu')";
    if (q.trim().length < 3) return "Type 3+ characters to search";
    return "Use ↑/↓ and Enter";
  }, [q]);

  useEffect(() => {
    // close dropdown on outside click
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    // Debounced fetch
    abortRef.current?.abort();
    setActiveIndex(-1);

    if (!canSearch) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setOpen(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/players/search?q=${encodeURIComponent(q.trim())}&limit=10`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (data?.ok) setResults(data.results ?? []);
        else setResults([]);
      } catch (e: any) {
        if (e?.name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [q, canSearch]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min((results.length ? results.length - 1 : 0), i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && results[activeIndex]) {
        const r = results[activeIndex];
        window.location.href = `/players/${r.id}`;
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div ref={boxRef} className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="space-y-2">
        <label className="text-sm font-semibold text-zinc-900">Find a player</label>

        <div className="relative">
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Start typing…"
            className="w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none focus:border-zinc-900"
          />

          <div className="mt-2 text-xs text-zinc-500">
            {loading ? "Searching…" : hint}
          </div>

          {open && canSearch && (
            <div className="absolute z-50 mt-3 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg">
              {results.length === 0 && !loading ? (
                <div className="p-4 text-sm text-zinc-600">No matches.</div>
              ) : (
                <ul className="max-h-80 overflow-auto">
                  {results.map((r, idx) => {
                    const label = r.fullName ?? r.id;
                    const meta = [r.position, r.team].filter(Boolean).join(" • ");
                    return (
                      <li key={r.id}>
                        <a
                          href={`/players/${r.id}`}
                          className={clsx(
                            "block px-4 py-3 text-sm",
                            idx === activeIndex ? "bg-zinc-100" : "hover:bg-zinc-50"
                          )}
                          onMouseEnter={() => setActiveIndex(idx)}
                        >
                          <div className="font-semibold text-zinc-900">{label}</div>
                          <div className="text-xs text-zinc-600">
                            {meta || "—"} {r.status ? `• ${r.status}` : ""}
                          </div>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700">
          Tip: Once this is hooked into your Transactions page, we can make player names clickable to jump
          straight to their history.
        </div>
      </div>
    </div>
  );
}
