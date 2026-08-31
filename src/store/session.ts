import { create } from "zustand";
import type { InitResult } from "../api/types";

interface SessionState {
  /** The connection gate passed: a backend answered a chain query and Tor bootstrapped. */
  connected: boolean;
  setConnected: () => void;
  initialized: boolean;
  walletName: string | null;
  dataDir: string | null;
  recoveryPending: boolean;
  setInitialized: (result: InitResult) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  connected: false,
  setConnected: () => set({ connected: true }),
  initialized: false,
  walletName: null,
  dataDir: null,
  recoveryPending: false,
  setInitialized: (result) =>
    set({
      initialized: true,
      walletName: result.walletName,
      dataDir: result.dataDir,
      recoveryPending: result.recoveryPending,
    }),
  reset: () =>
    set({ initialized: false, walletName: null, dataDir: null, recoveryPending: false }),
}));
