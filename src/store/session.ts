import { create } from "zustand";
import type { InitResult } from "../api/types";

interface SessionState {
  /** null until the host has been asked; false shows the login gate. Desktop resolves to
   *  true immediately — the process is already the user's. */
  authenticated: boolean | null;
  hasOwner: boolean;
  setAuthenticated: (authenticated: boolean) => void;
  setHasOwner: (hasOwner: boolean) => void;
  /** The connection gate passed: a backend answered a chain query and Tor bootstrapped. */
  connected: boolean;
  setConnected: () => void;
  /** null until Rust has been asked. A reload replaces the page, not the process: the
   *  wallet the user unlocked is still open in Rust, so this is restored rather than
   *  assumed false. `false` means genuinely no wallet — asked and answered. */
  initialized: boolean | null;
  walletName: string | null;
  dataDir: string | null;
  setInitialized: (result: Pick<InitResult, "walletName" | "dataDir">) => void;
  setNotInitialized: () => void;
  reset: () => void;
}

/** Carries "the gate was passed" across the reload a sign-out does: Rust still holds the
 *  backend and Tor the gate checked, only this page's memory of it is gone. Read once, here,
 *  and per-tab, so it never outlives the reload it was written for. */
const GATE_HANDOFF_KEY = "portal.gate-handoff";

export function handOffGate() {
  try {
    sessionStorage.setItem(GATE_HANDOFF_KEY, "1");
  } catch {
    // Storage unavailable: the reload replays the gate instead, which is only slower.
  }
}

function takeGateHandoff(): boolean {
  try {
    const passed = sessionStorage.getItem(GATE_HANDOFF_KEY) === "1";
    sessionStorage.removeItem(GATE_HANDOFF_KEY);
    return passed;
  } catch {
    return false;
  }
}

export const useSessionStore = create<SessionState>((set) => ({
  authenticated: null,
  hasOwner: true,
  setAuthenticated: (authenticated) => set({ authenticated }),
  setHasOwner: (hasOwner) => set({ hasOwner }),
  connected: takeGateHandoff(),
  setConnected: () => set({ connected: true }),
  initialized: null,
  walletName: null,
  dataDir: null,
  setNotInitialized: () => set({ initialized: false }),
  setInitialized: (result) =>
    set({
      initialized: true,
      walletName: result.walletName,
      dataDir: result.dataDir,
    }),
  reset: () =>
    set({ initialized: false, walletName: null, dataDir: null }),
}));
