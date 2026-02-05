/*
  Centralized Sleeper API helpers

  Everything that talks to the Sleeper REST API lives here.
  Keep this file "dumb" and reusable.
*/

const BASE = "https://api.sleeper.app/v1";

/*
  ---------------------------------------
  Generic fetch helper
  ---------------------------------------
*/

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    // Next.js server routes should not cache Sleeper data
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sleeper API error ${res.status}: ${text}`);
  }

  return res.json();
}

/*
  ---------------------------------------
  League metadata
  ---------------------------------------
*/

export async function getLeague(leagueId: string) {
  // Contains season + previous_league_id (used for history chaining)
  return getJson<{
    league_id: string;
    season: string;
    previous_league_id: string | null;
    settings?: {
      playoff_week_start?: number;
    };
  }>(`/league/${leagueId}`);
}

/*
  ---------------------------------------
  League users
  ---------------------------------------
*/

export async function getUsers(leagueId: string) {
  return getJson<
    Array<{
      user_id: string;
      username?: string;
      display_name?: string;
    }>
  >(`/league/${leagueId}/users`);
}

/*
  ---------------------------------------
  Rosters
  ---------------------------------------
*/

export async function getRosters(leagueId: string) {
  return getJson<
    Array<{
      roster_id: number;
      owner_id: string | null;
    }>
  >(`/league/${leagueId}/rosters`);
}

/*
  ---------------------------------------
  Weekly matchups
  ---------------------------------------
*/

export async function getMatchups(leagueId: string, week: number) {
  return getJson<
    Array<{
      roster_id: number;
      matchup_id: number | null;
      points: number;
    }>
  >(`/league/${leagueId}/matchups/${week}`);
}

/*
  ---------------------------------------
  Weekly transactions
  ---------------------------------------
*/

export async function getTransactions(leagueId: string, week: number) {
  return getJson<
    Array<{
      transaction_id: string;
      type: string;
      status: string;
      created: number;

      adds?: Record<string, number>;
      drops?: Record<string, number>;

      draft_picks?: Array<{
        season: number;
        round: number;
        owner_id: number | null;
        previous_owner_id: number | null;
        roster_id?: number | null; // original roster slot (often present in Sleeper tx payloads)
      }>;

      settings?: {
        waiver_budget?: number;
      };
    }>
  >(`/league/${leagueId}/transactions/${week}`);
}

/*
  ---------------------------------------
  Drafts for a league
  ---------------------------------------
*/

export async function getLeagueDrafts(leagueId: string) {
  return getJson<
    Array<{
      draft_id: string;
      season: string | number;
      type?: string;
      status?: string;
    }>
  >(`/league/${leagueId}/drafts`);
}

/*
  ---------------------------------------
  Single draft metadata (includes draft_order)
  ---------------------------------------
*/

export async function getDraft(draftId: string) {
  return getJson<{
    draft_id: string;
    season: string | number;
    status?: string;
    type?: string;
    // draft_order: { [roster_id: number]: slot(1..N) }
    draft_order?: Record<string, number>;
  }>(`/draft/${draftId}`);
}

/*
  ---------------------------------------
  Draft picks for a draft
  ---------------------------------------
*/

export async function getDraftPicks(draftId: string) {
  return getJson<
    Array<{
      round: number;
      roster_id: number | null;
      player_id: string | null;
      pick_no?: number; // often present
    }>
  >(`/draft/${draftId}/picks`);
}

/*
  ---------------------------------------
  Full NFL players dictionary
  (used for player name lookups)
  ---------------------------------------
*/

export async function getAllNflPlayers() {
  return getJson<Record<string, any>>(`/players/nfl`);
}
/*
  ---------------------------------------
  Single draft metadata (includes draft_order)
  ---------------------------------------
*/
export async function getDraft(draftId: string) {
  return getJson<{
    draft_id: string;
    season: string | number;
    status?: string;
    type?: string;
    // draft_order: { [roster_id: number]: slot(1..N) }
    draft_order?: Record<string, number>;
  }>(`/draft/${draftId}`);
}
