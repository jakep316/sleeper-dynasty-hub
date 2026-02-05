import PlayersSearchClient from "./PlayersSearchClient";

export const dynamic = "force-dynamic";

export default function PlayersPage() {
  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold">Player Search</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Start typing a name (autocomplete starts at <span className="font-semibold text-zinc-900">3+</span>{" "}
          characters).
        </p>
      </div>

      <PlayersSearchClient />
    </main>
  );
}
