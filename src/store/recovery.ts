import { create } from "zustand";
import { getRecoveryStatus } from "../api/commands";

/**
 * Gates the recovery entry points — the header pill and the Swap page's Recovery button. Kept as
 * one switch so the feature can be held back without unpicking it.
 */
export const RECOVERY_UI_ENABLED = true;

/**
 * Whether any swap still has funds sitting in a contract.
 *
 * One poll for the whole app, in the shell, because recovery outlives the Swap page: the header
 * pill and the Swap page's Recovery button are both reading the same answer, and the recovery
 * page does its own fuller read.
 */
interface RecoveryState {
  active: boolean;
  refresh: () => Promise<void>;
  clear: () => void;
}

export const useRecoveryStore = create<RecoveryState>((set) => ({
  active: false,
  refresh: async () => {
    try {
      const status = await getRecoveryStatus();
      set({ active: status.active });
    } catch {
      // A wallet that isn't open yet, or a read that failed — either way, claiming recovery is
      // running would put a warning in the header on no evidence.
      set({ active: false });
    }
  },
  clear: () => set({ active: false }),
}));
