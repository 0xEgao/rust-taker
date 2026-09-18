import { create } from "zustand";
import { operations } from "../platform";
import type { UnresolvedOperation } from "../api/host-contract";

/**
 * Payments whose outcome the server could not confirm, and which therefore hold up new
 * spending.
 *
 * Normally this resolves itself: the transaction is sitting in the mempool, so re-reading the
 * chain settles it and the block lifts with nobody doing anything. Only a payment for which no
 * transaction id was ever recorded needs the owner, because there is nothing to look for.
 */
const RECHECK_MS = 60_000;

interface UnresolvedState {
  blocking: UnresolvedOperation[];
  /** Null until the first read, so the UI can avoid claiming "nothing is blocked" too early. */
  checked: boolean;
  refresh: () => Promise<void>;
  acknowledge: (id: string) => Promise<void>;
  /** Closing a wallet has to drop this: the list gates Send and Swap and shows txids, and
   *  one wallet's blocked payments must never be charged against the next one. */
  reset: () => void;
}

export const useUnresolvedStore = create<UnresolvedState>((set, get) => ({
  blocking: [],
  checked: false,
  refresh: async () => {
    const blocking = await operations.blocking().catch(() => get().blocking);
    set({ blocking, checked: true });
    // Ask the server to re-read the chain for anything that still has a txid to look for.
    // Settling one clears it from the next refresh.
    await Promise.all(
      blocking
        .filter((op) => op.result?.txid)
        .map((op) => operations.reconcile(op.operationId).catch(() => {})),
    );
  },
  acknowledge: async (id) => {
    await operations.acknowledge(id);
    await get().refresh();
  },
  reset: () => set({ blocking: [], checked: false }),
}));

/** Starts the recheck timer once for the app's lifetime. Safe to call from several places. */
let timer: ReturnType<typeof setInterval> | null = null;
export function watchUnresolved() {
  void useUnresolvedStore.getState().refresh();
  if (timer) return;
  timer = setInterval(() => void useUnresolvedStore.getState().refresh(), RECHECK_MS);
}
