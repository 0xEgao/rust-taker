import { create } from "zustand";
import { listMakers, listWallets } from "../api/commands";
import { loadDataDir } from "../pages/setup/types";

/** Bumped when the welcome content changes enough that returning users should see it again. */
export const ONBOARDING_VERSION = 1;

const STORAGE_KEY = "coinswap_onboarding";

export type Role = "taker" | "maker";

interface Persisted {
  seenVersion: number;
  lastRole: Role | null;
}

/**
 * Presentation metadata only. Which resources exist is always re-read from disk (see
 * `resolve`) because wallets and maker registrations change outside this app, and whether a
 * taker is unlocked is per-launch memory state in `session.ts`. A single
 * `onboardingComplete` flag would drift from all three.
 */
function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { seenVersion: 0, lastRole: null };
    return { seenVersion: 0, lastRole: null, ...JSON.parse(raw) };
  } catch {
    return { seenVersion: 0, lastRole: null };
  }
}

function savePersisted(next: Persisted) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

interface BootstrapState {
  /** null until the first `resolve()` settles — routing must wait rather than guess. */
  walletCount: number | null;
  makerCount: number | null;
  seenVersion: number;
  lastRole: Role | null;
  resolve: () => Promise<void>;
  markSeen: () => void;
  setLastRole: (role: Role) => void;
  /** Called after a wallet or maker is created so guards re-open without a reload. */
  noteResourceAdded: (kind: Role) => void;
}

export const useBootstrapStore = create<BootstrapState>((set, get) => ({
  walletCount: null,
  makerCount: null,
  ...loadPersisted(),

  resolve: async () => {
    // Both are best-effort: a listing failure must not strand the user on a blank screen,
    // so an unreadable source counts as "nothing found" and the welcome still renders.
    const [wallets, makers] = await Promise.all([
      listWallets(loadDataDir()).catch(() => []),
      listMakers().catch(() => []),
    ]);
    set({ walletCount: wallets.length, makerCount: makers.length });
  },

  markSeen: () => {
    const next = { seenVersion: ONBOARDING_VERSION, lastRole: get().lastRole };
    savePersisted(next);
    set({ seenVersion: next.seenVersion });
  },

  setLastRole: (role) => {
    const next = { seenVersion: get().seenVersion, lastRole: role };
    savePersisted(next);
    set({ lastRole: role });
  },

  noteResourceAdded: (kind) => {
    set((s) =>
      kind === "taker"
        ? { walletCount: (s.walletCount ?? 0) + 1 }
        : { makerCount: (s.makerCount ?? 0) + 1 },
    );
  },
}));
