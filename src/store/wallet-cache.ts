import { create } from "zustand";
import type { Balances, TxSummary, UtxoEntry, WalletInfo } from "../api/types";

// Survives WalletPage unmount/remount so revisits paint instantly.
export const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const SYNC_TIME_STORAGE_KEY = "coinswap_wallet_last_sync";

export type WalletSyncStatus = "idle" | "syncing" | "synced" | "error";

function loadSyncTimes(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_TIME_STORAGE_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveSyncTime(walletKey: string, timestamp: number) {
  try {
    const times = loadSyncTimes();
    times[walletKey] = timestamp;
    localStorage.setItem(SYNC_TIME_STORAGE_KEY, JSON.stringify(times));
  } catch {
    // Timestamp persistence is informational and must not break wallet state.
  }
}

interface WalletCacheState {
  info: WalletInfo | null;
  balances: Balances | null;
  utxos: UtxoEntry[];
  transactions: TxSummary[];
  walletKey: string | null;
  syncStatus: WalletSyncStatus;
  syncError: string | null;
  lastSuccessfulSyncAt: number | null;
  beginSession: (walletName: string, dataDir: string, restored: boolean) => void;
  setSyncing: () => void;
  setSyncSuccess: (timestamp?: number) => void;
  setSyncError: (message: string) => void;
  setStoredData: (data: { info: WalletInfo; balances: Balances; utxos: UtxoEntry[] }) => void;
  setData: (data: { info: WalletInfo; balances: Balances; utxos: UtxoEntry[]; transactions: TxSummary[] }) => void;
}

export const useWalletCacheStore = create<WalletCacheState>((set) => ({
  info: null,
  balances: null,
  utxos: [],
  transactions: [],
  walletKey: null,
  syncStatus: "idle",
  syncError: null,
  lastSuccessfulSyncAt: null,
  beginSession: (walletName, dataDir, restored) => {
    const walletKey = `${dataDir}/wallets/${walletName}`;
    const lastSuccessfulSyncAt = restored ? Date.now() : (loadSyncTimes()[walletKey] ?? null);
    if (restored) saveSyncTime(walletKey, lastSuccessfulSyncAt);
    set((state) => ({
      walletKey,
      syncStatus: restored ? "synced" : "idle",
      syncError: null,
      lastSuccessfulSyncAt,
      // Never let a process-local snapshot from another wallet flash on screen.
      ...(state.walletKey !== null && state.walletKey !== walletKey
        ? { info: null, balances: null, utxos: [], transactions: [] }
        : {}),
    }));
  },
  setSyncing: () => set({ syncStatus: "syncing", syncError: null }),
  setSyncSuccess: (timestamp = Date.now()) =>
    set((state) => {
      if (state.walletKey) saveSyncTime(state.walletKey, timestamp);
      return { syncStatus: "synced", syncError: null, lastSuccessfulSyncAt: timestamp };
    }),
  setSyncError: (message) => set({ syncStatus: "error", syncError: message }),
  // Wallet balances and UTXOs are backed by the encrypted wallet file's persisted
  // UTXO cache. Hydrating them is local and must not claim that a network sync ran.
  setStoredData: (data) => set(data),
  setData: (data) => set(data),
}));
