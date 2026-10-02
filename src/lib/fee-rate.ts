import { useCallback, useEffect, useState } from "react";
import { estimateFees } from "../api/commands";
import type { FeeEstimate } from "../api/types";

export type FeeTier = "fast" | "medium" | "slow";

/** Portal's typo guard, the same one the backend applies to every swap and send. */
export const MAX_FEE_RATE = 500;
export type FeeChoice = FeeTier | "custom";

export const FEE_TIERS: { key: FeeTier; label: string }[] = [
  { key: "fast", label: "Fast" },
  { key: "medium", label: "Medium" },
  { key: "slow", label: "Slow" },
];

/** The session's chain server's estimate for each tier. */
export function useFeeEstimate() {
  const [fees, setFees] = useState<FeeEstimate | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    void estimateFees()
      .then(setFees)
      .catch(() => {
        setFees(null);
        setFailed(true);
      });
  }, []);
  useEffect(load, [load]);
  return { fees, failed, retry: load };
}

/** 0 when the choice has no usable rate yet; callers treat that as not ready. `whole` is for the
 *  swap, whose rate the crate takes in whole sats/vB. */
export function chosenFeeRate(
  fees: FeeEstimate | null,
  choice: FeeChoice,
  custom: string,
  whole = false,
): number {
  if (choice === "custom") {
    const text = custom.trim();
    const rate = Number(text);
    return text !== "" &&
      Number.isFinite(rate) &&
      rate >= 1 &&
      rate <= MAX_FEE_RATE &&
      (!whole || Number.isInteger(rate))
      ? rate
      : 0;
  }
  const rate = fees?.[choice];
  if (rate == null || !Number.isFinite(rate) || rate < 1 || rate > MAX_FEE_RATE) return 0;
  // Rounded up to the one decimal the rate is shown with, so a tier never pays under its estimate.
  return whole ? Math.max(1, Math.ceil(rate)) : Math.ceil(rate * 10) / 10;
}
