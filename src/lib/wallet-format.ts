// Ported from taker-app/src/js/coinswapHelpers.js so the new dashboard
// classifies UTXOs/transactions exactly like the shipped app did.

import { AlertCircle, CheckCircle2, XCircle, type LucideIcon } from "lucide-react";
import type { SwapStatus } from "../api/types";

export function truncateMiddle(value: string, start = 12, end = 8): string {
  if (!value || value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function formatRelativeTime(timestampSeconds: number): string {
  const diffMs = Date.now() - timestampSeconds * 1000;
  if (diffMs < 0) return "Just now";
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hr ago`;
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(timestampSeconds * 1000).toLocaleDateString();
}

export type UtxoBucket = "Regular" | "Swap" | "Contract" | "Fidelity";

export function classifySpendType(spendType: string): UtxoBucket {
  const normalized = spendType.toLowerCase();
  if (normalized.includes("swap")) return "Swap";
  if (normalized.includes("contract")) return "Contract";
  if (normalized.includes("fidelity")) return "Fidelity";
  return "Regular";
}

/** Address-prefix based, mirroring the old app's detectAddressType. */
export function scriptTypeFromAddress(address: string | undefined): "Taproot" | "SegWit" {
  const bech32 = address?.match(/^(bc|tb|bcrt)1([a-z0-9]+)$/i);
  if (bech32?.[2][0].toLowerCase() === "p") return "Taproot";
  return "SegWit";
}

export type TxKind = "received" | "sent" | "swap";

export function getTransactionKind(category: string, label: string | undefined, amountSats: number): TxKind {
  const haystack = `${category} ${label ?? ""}`.toLowerCase();
  if (haystack.includes("swap") || haystack.includes("contract") || haystack.includes("htlc")) {
    return "swap";
  }
  return amountSats >= 0 ? "received" : "sent";
}

export const EXPLORER_BASE_URL = "https://mempool.citadelfoss.xyz";

export function explorerTxUrl(txid: string): string {
  return `${EXPLORER_BASE_URL}/tx/${encodeURIComponent(txid)}`;
}

// ---------------------------------------------------------------------------
// Amount input formatting — shared by Send and Swap (btcPriceUsd comes from getBtcPrice(),
// a live mempool.space quote).
// ---------------------------------------------------------------------------

export type Unit = "sats" | "btc" | "usd";

export const SATS_PER_BTC = 100_000_000;

function trimTrailingZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** amountSats -> a display string in `unit`, so switching units shows the equivalent amount, not a reinterpreted raw number. */
export function satsToUnitString(sats: number, unit: Unit, btcPriceUsd: number | null): string {
  if (sats <= 0) return "";
  if (unit === "sats") return String(Math.round(sats));
  const btc = sats / SATS_PER_BTC;
  if (unit === "btc") return trimTrailingZeros(btc.toFixed(8));
  return btcPriceUsd ? (btc * btcPriceUsd).toFixed(2) : "";
}

export function unitStringToSats(input: string, unit: Unit, btcPriceUsd: number | null): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (unit === "sats") return Math.round(n);
  if (unit === "btc") return Math.round(n * SATS_PER_BTC);
  if (!btcPriceUsd) return 0;
  return Math.round((n / btcPriceUsd) * SATS_PER_BTC);
}

/** Display string for `sats` expressed in `unit`, e.g. the two non-selected units shown under an amount input. */
export function formatUnitAmount(sats: number, unit: Unit, btcPriceUsd: number | null): string | null {
  if (sats <= 0) return null;
  if (unit === "sats") return `${Math.round(sats).toLocaleString()} sats`;
  const btc = sats / SATS_PER_BTC;
  if (unit === "btc") return `${trimTrailingZeros(btc.toFixed(8))} BTC`;
  return btcPriceUsd ? `≈ $${(btc * btcPriceUsd).toFixed(2)}` : null;
}

// Fee rates come back as raw floats from a live market API (e.g. 1.0070000000000001) — round for display.
export function formatFeeRate(rate: number): string {
  return rate.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

// ---------------------------------------------------------------------------
// Log line classification — shared by the standalone Logs page and the Swap
// page's inline log panel, both reading the crate's log4rs-formatted lines.
// ---------------------------------------------------------------------------

export type LogLevel = "error" | "warn" | "info" | "debug" | "other";

export function logLevel(line: string): LogLevel {
  if (/\bERROR\b/.test(line)) return "error";
  if (/\bWARN\b/.test(line)) return "warn";
  if (/\bINFO\b/.test(line)) return "info";
  if (/\bDEBUG\b|\bTRACE\b/.test(line)) return "debug";
  return "other";
}

export const LOG_LEVEL_TONE: Record<LogLevel, string> = {
  error: "text-danger",
  warn: "text-warning",
  info: "text-muted",
  debug: "text-subtle",
  other: "text-muted",
};

// ---------------------------------------------------------------------------
// Swap status presentation — shared by the reports list and detail pages.
// Labels differ per page ("Success" vs "Completed") and stay local to each.
// ---------------------------------------------------------------------------

export const SWAP_STATUS_ICON: Record<SwapStatus, LucideIcon> = {
  success: CheckCircle2,
  recovery_hashlock: AlertCircle,
  recovery_timelock: AlertCircle,
  failed: XCircle,
};

export const SWAP_STATUS_TEXT_TONE: Record<SwapStatus, string> = {
  success: "text-success",
  recovery_hashlock: "text-warning",
  recovery_timelock: "text-warning",
  failed: "text-danger",
};

export const SWAP_STATUS_CHIP_TONE: Record<SwapStatus, string> = {
  success: "border-success/45 bg-success/[0.08] text-success",
  recovery_hashlock: "border-warning/45 bg-warning/[0.08] text-warning",
  recovery_timelock: "border-warning/45 bg-warning/[0.08] text-warning",
  failed: "border-danger/45 bg-danger/[0.08] text-danger",
};
