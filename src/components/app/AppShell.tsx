import { ArrowLeft, Check, CheckCircle2, RefreshCw, Server, Settings, X, XCircle } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Background } from "../ui/layout";
import { useHeaderActionsStore } from "../../store/header-actions";
import { useSessionStore } from "../../store/session";
import { useToastStore } from "../../store/toast";
import { IconButton } from "../ui/display";

const TAKER_NAV_ITEMS: { path: string; label: string; d: string }[] = [
  { path: "/", label: "Wallet", d: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 14h2"/>' },
  { path: "/market", label: "Market", d: '<path d="M4 19V9M10 19V5M16 19v-7M22 19V8"/>' },
  { path: "/send", label: "Send", d: '<path d="M7 17L17 7M9 7h8v8"/>' },
  { path: "/swap", label: "Swap", d: '<path d="M17 4l4 4-4 4M21 8H8M7 20l-4-4 4-4M3 16h13"/>' },
];

function Logo({
  makerMode,
  atMakerRoot,
  takerUnlocked,
}: {
  makerMode: boolean;
  atMakerRoot: boolean;
  takerUnlocked: boolean;
}) {
  // Only the fleet leaves the maker side; every maker sub-page steps back to the fleet first.
  // A maker-only session has no taker to return to — leaving means going back to the role
  // picker and unlocking a wallet there.
  const [to, title] = !makerMode
    ? ["/", "Open wallet"]
    : !atMakerRoot
      ? ["/maker", "Back to your makers"]
      : takerUnlocked
        ? ["/", "Return to Taker wallet"]
        : ["/launch", "Back to start"];

  return (
    <NavLink
      to={to}
      title={title}
      className="group flex items-center gap-3 rounded-control outline-none focus-visible:shadow-ring"
    >
      {makerMode ? (
        <span className="flex items-center gap-2 font-header text-[15px] font-bold text-foreground transition-colors group-hover:text-primary">
          <ArrowLeft size={16} strokeWidth={2} className="text-primary" /> Portal
        </span>
      ) : (
        <>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary font-header text-[15px] font-bold text-on-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.24),0_6px_16px_-8px_color-mix(in_oklab,var(--color-primary)_60%,transparent)]">P</div>
          <div className="min-w-0 leading-tight">
            <div className="font-header text-[15px] font-bold text-foreground">Portal</div>
            <div className="text-[11px] text-subtle">Taker Wallet</div>
          </div>
        </>
      )}
    </NavLink>
  );
}

function TopNav({
  makerMode,
  atMakerRoot,
  takerUnlocked,
}: {
  makerMode: boolean;
  atMakerRoot: boolean;
  takerUnlocked: boolean;
}) {
  const onRefresh = useHeaderActionsStore((s) => s.onRefresh);
  const refreshing = useHeaderActionsStore((s) => s.refreshing);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const wasRefreshing = useRef(refreshing);

  useEffect(() => {
    if (wasRefreshing.current && !refreshing) {
      setJustRefreshed(true);
      const t = setTimeout(() => setJustRefreshed(false), 1600);
      wasRefreshing.current = refreshing;
      return () => clearTimeout(t);
    }
    wasRefreshing.current = refreshing;
  }, [refreshing]);

  return (
    <header
      className="sticky top-0 z-30 grid flex-none grid-cols-[1fr_auto_1fr] items-center gap-6 px-8 py-5"
      style={{
        background:
          "linear-gradient(to bottom, color-mix(in oklab, var(--color-bg) 92%, transparent) 0%, color-mix(in oklab, var(--color-bg) 92%, transparent) 65%, transparent 100%)",
        backdropFilter: "blur(6px)",
      }}
    >
      <Logo makerMode={makerMode} atMakerRoot={atMakerRoot} takerUnlocked={takerUnlocked} />

      <nav className="flex items-center gap-1" aria-label="Main navigation">
        {makerMode ? (
          <div className="flex items-center gap-2 rounded-pill border border-primary/25 bg-primary/[0.07] px-3.5 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
            <Server size={13} strokeWidth={1.9} /> Maker Dashboard
          </div>
        ) : TAKER_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) =>
              `relative flex items-center gap-2 rounded-control px-3.5 py-2 text-[13.5px] outline-none transition-colors duration-200 focus-visible:shadow-ring active:translate-y-px ${
                isActive ? "font-semibold text-primary" : "font-medium text-muted hover:text-foreground"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <svg
                  className="h-4 w-4 flex-none stroke-current"
                  viewBox="0 0 24 24"
                  fill="none"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: item.d }}
                />
                <span>{item.label}</span>
                {isActive && (
                  <>
                    <motion.span
                      layoutId="nav-active-glow"
                      transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.6 }}
                      className="pointer-events-none absolute -inset-x-14 -bottom-4 -z-10 h-10 blur-md"
                      style={{
                        background:
                          "radial-gradient(ellipse 50% 100% at 50% 0%, color-mix(in oklab, var(--color-primary) 50%, transparent) 0%, color-mix(in oklab, var(--color-primary) 18%, transparent) 50%, transparent 100%)",
                      }}
                    />
                    <motion.span
                      layoutId="nav-active-line"
                      transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.6 }}
                      className="pointer-events-none absolute -inset-x-10 -bottom-1.5 h-px"
                      style={{
                        background: "linear-gradient(to right, transparent, color-mix(in oklab, var(--color-primary-hover) 85%, transparent), transparent)",
                      }}
                    />
                  </>
                )}
              </>
            )}
          </NavLink>
        ))}
        {!makerMode && (
          <>
            <span className="mx-2 h-5 w-px bg-line-strong" aria-hidden="true" />
            <NavLink
              to="/maker"
              className="lift flex items-center gap-2 rounded-control border border-maker/25 bg-maker/[0.07] px-3.5 py-2 text-[12.5px] font-semibold text-maker outline-none hover:border-maker/45 hover:bg-maker/[0.12] focus-visible:shadow-ring"
            >
              <Server size={14} strokeWidth={1.9} />
              Maker Console
              <span aria-hidden="true">→</span>
            </NavLink>
          </>
        )}
      </nav>

      {/* Refresh is taker-only (Wallet is the only page that registers a handler), but the
          chain-backend and Tor settings are shared, so the maker side keeps its own way in. */}
      <div className="flex items-center justify-self-end gap-2">
        {!makerMode && (
          <IconButton
            onClick={() => onRefresh?.()}
            disabled={!onRefresh}
            label="Refresh"
            className={justRefreshed ? "text-success" : ""}
            icon={justRefreshed ? (
              <Check size={16} strokeWidth={2} />
            ) : (
              <RefreshCw size={16} strokeWidth={1.8} className={refreshing ? "animate-spin" : ""} />
            )}
          />
        )}
        <NavLink
          to="/settings"
          title="Settings"
          className={({ isActive }) =>
            `flex h-9 w-9 items-center justify-center rounded-control border border-line bg-surface-raised shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] outline-none transition-colors duration-200 focus-visible:shadow-ring active:translate-y-px ${
              isActive ? "text-primary" : "text-muted hover:text-foreground"
            }`
          }
        >
          <Settings size={16} strokeWidth={1.8} />
        </NavLink>
      </div>
    </header>
  );
}

// Stacks with a translateY(index*56px) offset, mirroring the old app's showToast.
function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50">
      <AnimatePresence>
      {toasts.map((t, i) => (
        <motion.div
          key={t.id}
          initial={{ opacity: 0, x: 18, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 12, scale: 0.98 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          style={{ top: i * 64 }}
          className={`raised pointer-events-auto absolute right-0 flex w-[420px] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-card border px-4 py-3.5 ${
            t.kind === "error"
              ? "border-danger/32 bg-danger/[0.18] text-foreground"
              : "border-success/32 bg-success/[0.14] text-foreground"
          }`}
        >
          {t.kind === "error" ? (
            <XCircle size={20} strokeWidth={2} className="mt-0.5 flex-none text-danger" />
          ) : (
            <CheckCircle2 size={20} strokeWidth={2} className="mt-0.5 flex-none text-success" />
          )}
          <div className="min-w-0">
            <strong className="block">{t.kind === "error" ? "Error" : "Success"}</strong>
            <span className="mt-0.5 block break-words text-[13px] text-muted">{t.message}</span>
          </div>
          <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="ml-2 flex-none rounded-sm text-subtle outline-none hover:text-foreground focus-visible:shadow-ring active:translate-y-px">
            <X size={14} strokeWidth={2} />
          </button>
        </motion.div>
      ))}
      </AnimatePresence>
    </div>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();
  const makerMode = pathname.startsWith("/maker");
  const atMakerRoot = pathname === "/maker";
  const takerUnlocked = useSessionStore((s) => s.initialized);

  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      document.documentElement.classList.add("is-scrolling");
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => document.documentElement.classList.remove("is-scrolling"), 120);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      if (settleTimer) clearTimeout(settleTimer);
      document.documentElement.classList.remove("is-scrolling");
    };
  }, []);

  return (
    // Scopes the accent to the whole maker side, nav item included, so crossing between
    // maker screens never crosses a colour boundary.
    <div className="relative h-screen" data-accent={makerMode ? "maker" : undefined}>
      <Background />
      <div className="relative flex h-screen flex-col">
        <TopNav makerMode={makerMode} atMakerRoot={atMakerRoot} takerUnlocked={takerUnlocked} />
        <main className="flex min-h-0 min-w-0 flex-1">
          {/* Keyed on the path so every route change gets a deliberate upward reveal. The new
              route enters immediately; avoiding a blocking exit keeps navigation responsive. */}
          <motion.div
            key={pathname}
            initial={
              reduceMotion
                ? { opacity: 1 }
                : { opacity: 0, y: 30, scale: 0.992, filter: "blur(5px)" }
            }
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { duration: 0.62, ease: [0.16, 1, 0.3, 1] }
            }
            style={{ transformOrigin: "50% 0%", willChange: "transform, opacity, filter" }}
            className="h-full min-w-0 flex-1"
          >
            <Outlet />
          </motion.div>
        </main>
      </div>
      <ToastStack />
    </div>
  );
}
