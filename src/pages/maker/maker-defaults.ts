/**
 * Economics a maker starts with. Quick create applies these silently and the full Add Maker form
 * pre-fills them, so the two can never drift into producing differently-configured makers.
 * All of them are editable later from a maker's Settings tab.
 */
export const MAKER_DEFAULTS = {
  minSwapAmount: 100_000,
  fidelityAmount: 100_000,
  fidelityTimelock: 15_000,
  requiredConfirms: 1,
  baseFee: 1_000,
  amountRelativeFeePct: 0.025,
  timeRelativeFeePct: 0.001,
} as const;

// Mirrors the backend's `valid_id`, so a rejected name is caught before the round trip.
export const MAKER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
