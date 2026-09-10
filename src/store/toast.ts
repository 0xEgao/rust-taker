import { create } from "zustand";
import { isAppError } from "../api/types";

export interface Toast {
  id: number;
  kind: "success" | "warning" | "error";
  message: string;
  /** Null for a toast that waits to be dismissed. Carried so the view can drain a timer bar. */
  dismissAfterMs: number | null;
}

let nextId = 0;

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast["kind"], message: string) => void;
  /** Reports a failed command, demoting the expected ones to a warning. */
  pushFailure: (error: unknown, fallback: string) => void;
  dismiss: (id: number) => void;
  /** Holds a toast open while the pointer is on it — 4s is not long enough to read and aim. */
  pause: (id: number) => void;
  resume: (id: number) => void;
}

// A warning stays until dismissed: unlike an error it describes a condition that is still
// true — a swap holds the wallet for as long as it runs — so timing it out would hide
// something the user is still living with.
const DISMISS_AFTER_MS: Record<Toast["kind"], number | null> = {
  success: 4000,
  warning: null,
  error: 5000,
};

// Kept outside the store so a pause can cancel the pending removal; the store only holds what
// the view renders.
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function armDismiss(
  set: (fn: (s: ToastState) => Partial<ToastState>) => void,
  id: number,
  after: number,
) {
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, after),
  );
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = ++nextId;
    const dismissAfterMs = DISMISS_AFTER_MS[kind];
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, dismissAfterMs }] }));
    if (dismissAfterMs !== null) armDismiss(set, id, dismissAfterMs);
  },
  pushFailure: (error, fallback) => {
    const appError = isAppError(error) ? error : null;
    // Reaching a wallet command mid-swap is the protocol working as designed, not a fault:
    // the swap holds the wallet for its whole duration.
    const kind = appError?.code === "SWAP_IN_PROGRESS" ? "warning" : "error";
    // `isAppError` only proves `code` is there. Rendering a non-string `message` would throw
    // inside the toast rather than report whatever actually went wrong.
    const message = typeof appError?.message === "string" ? appError.message : fallback;
    useToastStore.getState().push(kind, message);
  },
  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  pause: (id) => {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(id);
  },
  resume: (id) => {
    if (timers.has(id)) return;
    const toast = useToastStore.getState().toasts.find((t) => t.id === id);
    if (!toast?.dismissAfterMs) return;
    armDismiss(set, id, toast.dismissAfterMs);
  },
}));
