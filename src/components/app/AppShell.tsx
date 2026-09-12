import { AlertTriangle, ArrowLeft, Check, CheckCircle2, Link2, RefreshCw, ScrollText, Server, X, XCircle } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { checkBackend, getChainBackend } from "../../api/commands";
import { Background } from "../ui/layout";
import { useHeaderActionsStore } from "../../store/header-actions";
import { RECOVERY_UI_ENABLED, useRecoveryStore } from "../../store/recovery";
import { useSessionStore } from "../../store/session";
import { useToastStore, type Toast } from "../../store/toast";
import { IconButton } from "../ui/display";

/**
 * Read-only, because the backend is adopted at the connection gate and held for the session.
 * Past that gate nothing else in the app says what it is connected to, which is the half of the
 * old Electron settings page that was actually missing.
 */
/** Signet and testnet coins are worthless; mainnet coins are not. Which chain you are on is the
 *  most consequential fact about the session, so it leads and it is coloured. */
const NETWORK_TONE: Record<string, string> = {
  bitcoin: "border-success/40 bg-success/[0.08] text-success",
  testnet: "border-warning/40 bg-warning/[0.08] text-warning",
  testnet4: "border-warning/40 bg-warning/[0.08] text-warning",
  signet: "border-warning/40 bg-warning/[0.08] text-warning",
  regtest: "border-line-strong bg-white/[0.04] text-muted",
};

function ConnectionChip() {
  const [network, setNetwork] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [detail, setDetail] = useState("");

  useEffect(() => {
    void getChainBackend()
      .then((config) => {
        // A node you run yourself has no Tor/clearnet axis, so only Electrum carries a route.
        setBackend(
          config.kind === "coreRpc"
            ? "Bitcoin Core"
            : `Electrum · ${config.electrum.useTor ? "Tor" : "Clearnet"}`,
        );
        setDetail(
          config.kind === "coreRpc" && config.node
            ? `${config.node.host}:${config.node.port}`
            : config.electrum.url,
        );
      })
      .catch(() => setBackend(null));
    // Asked of the chain rather than inferred from the endpoint: the URL says nothing about
    // which network the server is actually serving.
    void checkBackend()
      .then((status) => setNetwork(status.chain ?? null))
      .catch(() => setNetwork(null));
  }, []);

  if (!network && !backend) return null;
  return (
    <span className="hidden items-center gap-1.5 md:inline-flex">
      {network && (
        <span
          className={`rounded-pill border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest ${
            NETWORK_TONE[network] ?? NETWORK_TONE.regtest
          }`}
        >
          {network === "bitcoin" ? "mainnet" : network}
        </span>
      )}
      {backend && (
        <span
          title={detail}
          className="inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface-raised px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-subtle"
        >
          <Link2 size={11} strokeWidth={2} />
          {backend}
        </span>
      )}
    </span>
  );
}

const WALLET_NAV_ITEMS: { path: string; label: string; d: string }[] = [
  { path: "/", label: "Wallet", d: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 14h2"/>' },
  { path: "/market", label: "Market", d: '<path d="M4 19V9M10 19V5M16 19v-7M22 19V8"/>' },
  { path: "/send", label: "Send", d: '<path d="M7 17L17 7M9 7h8v8"/>' },
  { path: "/swap", label: "Swap", d: '<path d="M17 4l4 4-4 4M21 8H8M7 20l-4-4 4-4M3 16h13"/>' },
];

function Logo({
  routerMode,
  atRouterRoot,
  walletUnlocked,
}: {
  routerMode: boolean;
  atRouterRoot: boolean;
  walletUnlocked: boolean;
}) {
  // Only the fleet leaves the router side; every router sub-page steps back to the fleet first.
  // A router-only session has no wallet to return to — leaving means going back to the role
  // picker and unlocking a wallet there.
  const [to, title] = !routerMode
    ? ["/", "Open wallet"]
    : !atRouterRoot
      ? ["/router", "Back to your routers"]
      : walletUnlocked
        ? ["/", "Return to wallet"]
        : ["/launch", "Back to start"];

  return (
    <NavLink
      to={to}
      title={title}
      className="group flex items-center gap-3 rounded-control outline-none focus-visible:shadow-ring"
    >
      {routerMode ? (
        <span className="flex items-center gap-2 font-header text-[15px] font-bold text-foreground transition-colors group-hover:text-primary">
          <ArrowLeft size={16} strokeWidth={2} className="text-primary" /> Portal
        </span>
      ) : (
        <>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary font-header text-[15px] font-bold text-on-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.24),0_6px_16px_-8px_color-mix(in_oklab,var(--color-primary)_60%,transparent)]">P</div>
          <div className="min-w-0 leading-tight">
            <div className="font-header text-[15px] font-bold text-foreground">Portal</div>
            <div className="text-[11px] text-subtle">Wallet</div>
          </div>
        </>
      )}
    </NavLink>
  );
}

function TopNav({
  routerMode,
  atRouterRoot,
  walletUnlocked,
}: {
  routerMode: boolean;
  atRouterRoot: boolean;
  walletUnlocked: boolean;
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
      <Logo routerMode={routerMode} atRouterRoot={atRouterRoot} walletUnlocked={walletUnlocked} />

      <nav className="flex items-center gap-1" aria-label="Main navigation">
        {routerMode ? (
          <div className="flex items-center gap-2 rounded-pill border border-primary/25 bg-primary/[0.07] px-3.5 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
            <Server size={13} strokeWidth={1.9} /> Router Dashboard
          </div>
        ) : WALLET_NAV_ITEMS.map((item) => (
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
        {!routerMode && (
          <>
            <span className="mx-2 h-5 w-px bg-line-strong" aria-hidden="true" />
            <NavLink
              to="/router"
              className="lift flex items-center gap-2 rounded-control border border-router/25 bg-router/[0.07] px-3.5 py-2 text-[12.5px] font-semibold text-router outline-none hover:border-router/45 hover:bg-router/[0.12] focus-visible:shadow-ring"
            >
              <Server size={14} strokeWidth={1.9} />
              Router Console
              <span aria-hidden="true">→</span>
            </NavLink>
          </>
        )}
      </nav>

      {/* Wallet is the only page that registers a refresh handler, so both of these are
          wallet-only — a router reads its own log from its workspace instead. */}
      <div className="flex items-center justify-self-end gap-2">
        <ConnectionChip />
        {!routerMode && (
          <>
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
            <NavLink
              to="/logs"
              title="Logs"
              className={({ isActive }) =>
                `flex h-9 w-9 items-center justify-center rounded-control border border-line bg-surface-raised shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] outline-none transition-colors duration-200 focus-visible:shadow-ring active:translate-y-px ${
                  isActive ? "text-primary" : "text-muted hover:text-foreground"
                }`
              }
            >
              <ScrollText size={16} strokeWidth={1.8} />
            </NavLink>
          </>
        )}
      </div>
    </header>
  );
}

const RECOVERY_POLL_MS = 30_000;

const MAX_VISIBLE_TOASTS = 3;

const TOAST_TONE: Record<
  Toast["kind"],
  { rail: string; icon: string; role: "status" | "alert" }
> = {
  success: { rail: "bg-success", icon: "text-success", role: "status" },
  warning: { rail: "bg-warning", icon: "text-warning", role: "status" },
  error: { rail: "bg-danger", icon: "text-danger", role: "alert" },
};

function ToastRow({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const pause = useToastStore((s) => s.pause);
  const resume = useToastStore((s) => s.resume);
  const tone = TOAST_TONE[toast.kind];
  const Icon =
    toast.kind === "error" ? XCircle : toast.kind === "warning" ? AlertTriangle : CheckCircle2;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 18, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 12, scale: 0.98 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      role={tone.role}
      onMouseEnter={() => pause(toast.id)}
      onMouseLeave={() => resume(toast.id)}
      // Neutral surface with the status carried by the rail and the icon: a full-surface tint of
      // the semantic colour turns the whole strip into a muddy slab at this opacity. The shadow
      // is spelled out rather than using `raised`, whose accent-tinted layer would put a blue
      // glow under a green toast (and a violet one on the router side).
      className="pointer-events-auto relative flex w-[360px] max-w-[calc(100vw-2rem)] items-start gap-2.5 overflow-hidden rounded-control border border-line-strong bg-surface-raised py-3 pl-4 pr-3 shadow-[0_1px_2px_rgba(0,0,0,0.5),0_16px_32px_-16px_rgba(0,0,0,0.7)]"
    >
      <span className={`absolute inset-y-0 left-0 w-0.5 ${tone.rail}`} aria-hidden="true" />
      <Icon size={16} strokeWidth={2} className={`mt-px flex-none ${tone.icon}`} />
      <span
        className="min-w-0 flex-1 break-words text-[12.5px] leading-5 text-foreground line-clamp-3"
        title={toast.message}
      >
        {toast.message}
      </span>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismiss(toast.id)}
        className="-mr-1 -mt-1 grid h-6 w-6 flex-none place-items-center rounded-control text-subtle outline-none hover:text-foreground focus-visible:shadow-ring active:translate-y-px"
      >
        <X size={13} strokeWidth={2} />
      </button>
      {/* Only a timed toast gets the bar, which is what distinguishes it from a warning that is
          waiting on the user rather than on a clock. */}
      {toast.dismissAfterMs !== null && (
        <motion.span
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: toast.dismissAfterMs / 1000, ease: "linear" }}
          style={{ transformOrigin: "left" }}
          className={`absolute inset-x-0 bottom-0 h-px ${tone.rail} opacity-60`}
          aria-hidden="true"
        />
      )}
    </motion.div>
  );
}

function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  // Newest first, and capped: every failed command toasts, so a burst could otherwise fill the
  // viewport. Positioned clear of the header so it never covers the refresh and logs buttons.
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS).reverse();
  const hidden = toasts.length - visible.length;

  return (
    <div
      className="pointer-events-none fixed right-4 top-[68px] z-50 flex flex-col items-end gap-2"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {visible.map((t) => (
          <ToastRow key={t.id} toast={t} />
        ))}
      </AnimatePresence>
      {hidden > 0 && (
        <span className="rounded-pill border border-line bg-surface-raised px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-subtle">
          +{hidden} more
        </span>
      )}
    </div>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();
  const routerMode = pathname.startsWith("/router");
  const atRouterRoot = pathname === "/router";
  const walletUnlocked = useSessionStore((s) => s.initialized);
  const refreshRecovery = useRecoveryStore((s) => s.refresh);
  const clearRecovery = useRecoveryStore((s) => s.clear);

  // Recovery can take hours and outlives any one page, so the shell is what watches it. Slow
  // cadence: the crate's own loop only retries once a minute, and this read is off disk.
  useEffect(() => {
    // Nothing reads the result while the entry points are hidden, so don't poll for it.
    if (!RECOVERY_UI_ENABLED || !walletUnlocked) {
      clearRecovery();
      return;
    }
    void refreshRecovery();
    const id = setInterval(() => void refreshRecovery(), RECOVERY_POLL_MS);
    return () => clearInterval(id);
  }, [walletUnlocked, refreshRecovery, clearRecovery]);

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
    // Scopes the accent to the whole router side, nav item included, so crossing between
    // router screens never crosses a colour boundary.
    <div className="relative h-screen" data-accent={routerMode ? "router" : undefined}>
      <Background />
      <div className="relative flex h-screen flex-col">
        <TopNav routerMode={routerMode} atRouterRoot={atRouterRoot} walletUnlocked={walletUnlocked} />
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
