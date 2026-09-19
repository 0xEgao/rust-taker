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
  /** Only ever true on an answer we actually received. A query that failed, or has not run
   *  yet, leaves this false so "unknown" can never be read as "nothing is blocked". */
  checked: boolean;
  refresh: () => Promise<void>;
  acknowledge: (id: string) => Promise<void>;
  /** Closing a wallet has to drop this: the list gates Send and Swap and shows txids, and
   *  one wallet's blocked payments must never be charged against the next one. */
  reset: () => void;
}

// Bumped by every refresh and every reset; a query whose number is stale discards its answer.
let generation = 0;

/**
 * Whether spending must be held. Unknown counts as blocked: the whole point of the gate is
 * that a payment with an unresolved outcome must not be followed by another one.
 */
export function spendingBlocked(state: UnresolvedState): boolean {
  return !state.checked || state.blocking.length > 0;
}

export const useUnresolvedStore = create<UnresolvedState>((set) => ({
  blocking: [],
  checked: false,
  refresh: async () => {
    const mine = ++generation;
    let blocking: UnresolvedOperation[];
    try {
      blocking = await operations.blocking();
    } catch {
      // Keep whatever was known and stop claiming it was checked. The gate below reads an
      // unavailable journal as "still blocked": answering "nothing outstanding" because the
      // question could not be asked is how a second payment goes out over an unknown one.
      if (mine === generation) set({ checked: false });
      return;
    }
    // A slower earlier query, or one that was in flight when the wallet closed, must not
    // write its answer over a newer one — it would restore a list that is no longer true,
    // and after a switch that list belongs to the previous wallet.
    if (mine !== generation) return;
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
    await useUnresolvedStore.getState().refresh();
  },
  reset: () => {
    // Also retires any query still in flight, so its answer cannot land on the next wallet.
    generation += 1;
    set({ blocking: [], checked: false });
  },
}));

/** Starts the recheck timer once for the app's lifetime. Safe to call from several places. */
let timer: ReturnType<typeof setInterval> | null = null;
export function watchUnresolved() {
  void useUnresolvedStore.getState().refresh();
  if (timer) return;
  timer = setInterval(() => void useUnresolvedStore.getState().refresh(), RECHECK_MS);
}
