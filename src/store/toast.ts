import { create } from "zustand";
import { isAppError } from "../api/types";

export interface Toast {
  id: number;
  kind: "success" | "warning" | "error";
  message: string;
}

let nextId = 0;

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast["kind"], message: string) => void;
  /** Reports a failed command, demoting the expected ones to a warning. */
  pushFailure: (error: unknown, fallback: string) => void;
  dismiss: (id: number) => void;
}

// A warning stays until dismissed: unlike an error it describes a condition that is still
// true — a swap holds the taker for as long as it runs — so timing it out would hide
// something the user is still living with.
const DISMISS_AFTER_MS: Record<Toast["kind"], number | null> = {
  success: 4000,
  warning: null,
  error: 5000,
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = ++nextId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    const after = DISMISS_AFTER_MS[kind];
    if (after !== null) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, after);
    }
  },
  pushFailure: (error, fallback) => {
    const appError = isAppError(error) ? error : null;
    // Reaching a taker command mid-swap is the protocol working as designed, not a fault:
    // the swap holds the taker for its whole duration.
    const kind = appError?.code === "SWAP_IN_PROGRESS" ? "warning" : "error";
    useToastStore.getState().push(kind, appError?.message ?? fallback);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
