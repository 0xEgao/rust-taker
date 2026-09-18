/**
 * Economics a router starts with. Quick create applies these silently and the full Add Router form
 * pre-fills them, so the two can never drift into producing differently-configured routers.
 * The fees and limits are editable later from a router's Settings tab. The two fidelity
 * values are not: they are burned into the bond transaction when it is created, and
 * editing them afterwards only changes what the *next* bond uses, once this one's
 * timelock runs out. Anything shown to the user has to say so — the money is locked.
 */
/** Bitcoin targets a block every 10 minutes, so 144 a day. Approximate by construction. */
export function timelockDays(blocks: number): number {
  return Math.round(blocks / 144);
}

export const ROUTER_DEFAULTS = {
  minSwapAmount: 100_000,
  fidelityAmount: 100_000,
  fidelityTimelock: 15_000,
  requiredConfirms: 1,
  baseFee: 1_000,
  amountRelativeFeePct: 0.025,
  timeRelativeFeePct: 0.001,
} as const;

// Mirrors the backend's `valid_id`, so a rejected name is caught before the round trip.
export const ROUTER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
