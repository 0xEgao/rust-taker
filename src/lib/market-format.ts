// Ported from taker-app/src/js/coinswapHelpers.js (formatTorEndpoint,
// estimateMakerFee) so the Market page matches the old app's real fee math
// and address display exactly.

import { truncateMiddle } from "./wallet-format";

export function formatTorEndpoint(value: string, start = 12, end = 8, stripOnion = false): string {
  const text = (value ?? "").trim();
  if (!text) return "unknown";
  const noScheme = text.replace(/^https?:\/\//i, "").replace(/^tcp:\/\//i, "").split("/")[0];
  const separatorIndex = noScheme.lastIndexOf(":");
  let host = separatorIndex !== -1 ? noScheme.slice(0, separatorIndex) : noScheme;
  if (stripOnion) host = host.replace(/\.onion$/i, "");
  return truncateMiddle(host, start, end);
}

export interface MakerFeeEstimate {
  baseFee: number;
  liquidityFee: number;
  timeFee: number;
  totalFee: number;
  refundLocktime: number;
}

// totalFee = baseFee + amount*volumeRate + refundLocktime*amount*timeRate.
// refundLocktime = 20 * (totalMakers - position + 1).
export function estimateMakerFee(opts: {
  baseFee: number;
  amountRelativeFeePct: number;
  timeRelativeFeePct: number;
  amountSats: number;
  makerPosition: number;
  totalMakers: number;
}): MakerFeeEstimate {
  const refundLocktime = 20 * (opts.totalMakers - opts.makerPosition + 1);
  const liquidityFee = opts.amountSats * (opts.amountRelativeFeePct / 100);
  const timeFee = refundLocktime * opts.amountSats * (opts.timeRelativeFeePct / 100);
  return {
    baseFee: opts.baseFee,
    liquidityFee,
    timeFee,
    totalFee: opts.baseFee + liquidityFee + timeFee,
    refundLocktime,
  };
}

/** Total maker fees for a whole route, in sats. Mirrors Taker::prepare_coinswap: each hop
 * prices the amount remaining after the previous hop, and each individual maker fee is
 * rounded up to sats. */
export function estimateRouteMakerFees(
  makers: { baseFee: number; amountRelativeFeePct: number; timeRelativeFeePct: number }[],
  amountSats: number,
): number {
  let remaining = amountSats;
  let totalFeeSats = 0;
  for (let i = 0; i < makers.length; i += 1) {
    const maker = makers[i];
    const estimate = estimateMakerFee({
      ...maker,
      amountSats: remaining,
      makerPosition: i + 1,
      totalMakers: makers.length,
    });
    totalFeeSats += Math.ceil(estimate.totalFee);
    // The crate carries the unrounded f64 amount into the next hop.
    remaining = Math.max(0, remaining - estimate.totalFee);
  }
  return totalFeeSats;
}
