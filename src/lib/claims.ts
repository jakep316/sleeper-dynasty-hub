export function claimInactivityDays(): number {
  const n = Number(process.env.CLAIM_INACTIVITY_DAYS ?? "60");
  return Number.isFinite(n) && n > 0 ? n : 60;
}