export default function Home() {
  return (
    <div className="grid gap-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Ye Olde Fantasy — Dynasty Hub</h1>
          <p className="max-w-2xl text-zinc-600">
            A clean, searchable home for trades, transactions, and head-to-head history — all in one place.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <a
            href="/transactions"
            className="rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            View Transactions
          </a>
          <a
            href="/h2h"
            className="rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
          >
            View Head-to-Head
          </a>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Quick win</div>
          <div className="mt-2 text-lg font-semibold">Team names everywhere</div>
          <div className="mt-1 text-sm text-zinc-600">You just did this — it’s the biggest readability boost.</div>
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Next</div>
          <div className="mt-2 text-lg font-semibold">Player names</div>
          <div className="mt-1 text-sm text-zinc-600">Replace player IDs with real names + positions.</div>
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Automation</div>
          <div className="mt-2 text-lg font-semibold">Scheduled sync</div>
          <div className="mt-1 text-sm text-zinc-600">Nightly update so you never run curl again.</div>
        </div>
      </div>
    </div>
  );
}
