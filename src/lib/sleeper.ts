const BASE = "https://api.sleeper.app/v1";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Sleeper API error ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

export async function getLeague(leagueId: string) {
  return getJson<any>(`/league/${leagueId}`);
}
export async function getLeagueUsers(leagueId: string) {
  return getJson<any[]>(`/league/${leagueId}/users`);
}
export async function getLeagueRosters(leagueId: string) {
  return getJson<any[]>(`/league/${leagueId}/rosters`);
}
export async function getMatchups(leagueId: string, week: number) {
  return getJson<any[]>(`/league/${leagueId}/matchups/${week}`);
}
export async function getTransactions(leagueId: string, round: number) {
  return getJson<any[]>(`/league/${leagueId}/transactions/${round}`);
}

export async function getAllNflPlayers() {
  return getJson<Record<string, any>>(`/players/nfl`);
}

export async function getLeague(leagueId: string) {
  return getJson<{ league_id: string; previous_league_id: string | null }>(`/league/${leagueId}`);
}

export const getLeagueUsers = getUsers;
export const getLeagueRosters = getRosters;
export const getMatchupsForWeek = getMatchups;
export const getTransactionsForWeek = getTransactions;