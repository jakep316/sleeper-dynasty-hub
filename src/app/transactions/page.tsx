// src/app/transactions/page.tsx
import TransactionsClient from "./TransactionsClient";

export const dynamic = "force-dynamic";

export default function TransactionsPage() {
  const rootLeagueId = process.env.SLEEPER_LEAGUE_ID!;
  return <TransactionsClient rootLeagueId={rootLeagueId} />;
}
