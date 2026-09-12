import { create } from "zustand";
import { getRecoveryStatus } from "../api/commands";

/**
 * Gates the recovery entry point — the Swap page's Recovery button. Kept as one switch so the
 * feature can be held back without unpicking it.
 */
export const RECOVERY_UI_ENABLED = true;

/**
 * Whether any swap still has funds sitting in a contract.
 *
 * Polled in the shell rather than on the Swap page because recovery outlives any one page and
 * runs for hours. Only the Recovery button's highlight reads it; the recovery pages do their
 * own fuller read.
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
