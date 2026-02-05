import TransactionsClient from "./TransactionsClient";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const rootLeagueId = process.env.SLEEPER_LEAGUE_ID!;
  return <TransactionsClient leagueId={rootLeagueId} />;
}
