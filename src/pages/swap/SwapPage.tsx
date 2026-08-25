import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  FileText,
  Globe,
  RefreshCw,
  ShieldAlert,
  Wallet,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  estimateSwapFunding,
  getBtcPrice,
  getLogs,
  getOffers,
  getRecoveryStatus,
  getSwapProgress,
  getSwapTracker,
  prepareSwap,
  recoverSwap,
  startSwap,
} from "../../api/commands";
import { isAppError } from "../../api/types";
import type {
  AppError,
  LogLine,
  Maker,
  Outpoint,
  ProtocolVersion,
  RecoveryStatus,
  SwapLiquidity,
  SwapFundingEstimate,
  SwapRequest,
  SwapSummary,
  SwapTrackerProgress,
  TrackerPhase,
  UtxoEntry,
} from "../../api/types";
import {
  AmountTile,
  Card,
  Disclosure,
  LogViewer,
  SatsAmount,
  StatusChip,
} from "../../components/ui/display";
import {
  Button,
  PresetTile,
  SegmentedToggle,
  TextField,
} from "../../components/ui/inputs";
import {
  estimateRouteMakerFees,
  formatTorEndpoint,
} from "../../lib/market-format";
import {
  classifySpendType,
  formatDuration,
  formatUnitAmount,
  satsToUnitString,
  SATS_PER_BTC,
  truncateMiddle,
  unitStringToSats,
  type Unit,
} from "../../lib/wallet-format";
import { useToastStore } from "../../store/toast";
import { useWalletCacheStore } from "../../store/wallet-cache";

type UtxoFilter = "regular" | "swap";
type Lifecycle = "configure" | "running" | "finished" | "failed";
type RouteTone = "idle" | "active" | "success" | "danger";
type RouteNodeInfo = { tone: RouteTone; badge?: string };
const ROUTE_STATUS_TONE: Record<
  RouteTone,
  "subtle" | "primary" | "success" | "danger"
> = {
  idle: "subtle",
  active: "primary",
  success: "success",
  danger: "danger",
};

function EstimatedSats({
  sats,
  className,
}: {
  sats: number | null;
  className: string;
}) {
  return sats === null ? (
    <strong className="font-mono text-subtle">—</strong>
  ) : (
    <SatsAmount sats={sats} className={className} />
  );
}

const MAKER_COUNT_PRESETS = [2, 3, 4] as const;

function elapsedLabel(startedAt: number | null): string {
  if (!startedAt) return "0s";
  return formatDuration(Date.now() / 1000 - startedAt);
}

// Owns its own 1s tick so the rest of the progress screen (route diagram, framer-motion props
// and all) doesn't re-render every second just to update this one label.
function Elapsed({
  startedAt,
  active,
}: {
  startedAt: number | null;
  active: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return <>{elapsedLabel(startedAt)}</>;
}

const ROUTE_SIZE = 480;
const ROUTE_CENTER = ROUTE_SIZE / 2;
const ROUTE_RADIUS = 175;
const ROUTE_NODE_SIZE = 84;

const ROUTE_TONE_BORDER: Record<RouteTone, string> = {
  idle: "border-line-strong text-subtle",
  active: "border-primary/70 text-primary",
  success: "border-success/70 text-success",
  danger: "border-danger/70 text-danger",
};
const ROUTE_TONE_LABEL: Record<RouteTone, string> = {
  idle: "Waiting",
  active: "Active",
  success: "Complete",
  danger: "Failed",
};
const ROUTE_TONE_TEXT: Record<RouteTone, string> = {
  idle: "text-subtle",
  active: "text-foreground",
  success: "text-success",
  danger: "text-danger",
};
const ROUTE_TONE_GLOW: Record<RouteTone, string> = {
  idle: "rgba(255,255,255,0.06)",
  active: "color-mix(in oklab, var(--color-primary) 55%, transparent)",
  success: "color-mix(in oklab, var(--color-success) 55%, transparent)",
  danger: "color-mix(in oklab, var(--color-danger) 55%, transparent)",
};

// Live per-maker milestone counts -> a coarse visual tone (no progress yet / some / all done).
function stepsToTone(stepsDone: number, stepsTotal: number): RouteTone {
  if (stepsTotal > 0 && stepsDone >= stepsTotal) return "success";
  if (stepsDone > 0) return "active";
  return "idle";
}

const TRACKER_PHASE_LABEL: Record<TrackerPhase, string> = {
  makers_discovered: "Finding makers…",
  negotiated: "Negotiating…",
  funding_created: "Creating funding…",
  funds_broadcast: "Broadcasting funding…",
  contracts_exchanged: "Exchanging contracts…",
  finalizing: "Finalizing…",
  privkeys_forwarded: "Forwarding keys…",
  completed: "Swap Complete",
  failed: "Swap Failed",
};

function routeNodeXY(index: number, total: number) {
  const angle = -Math.PI / 2 + (index / total) * Math.PI * 2;
  return {
    x: ROUTE_CENTER + ROUTE_RADIUS * Math.cos(angle),
    y: ROUTE_CENTER + ROUTE_RADIUS * Math.sin(angle),
  };
}

/**
 * Radial route diagram — your wallet + one node per maker, driven by real live progress read
 * from the crate's own swap_tracker.cbor (see SwapPage's tracker-polling effect), same file the
 * old Electron app polled directly off disk. Each node gets its own tone/badge; a maker with no
 * milestones yet sits "idle" rather than pretending it's already active.
 */
function SwapRouteAnimation({
  wallet,
  makers,
  centerLabel,
  centerTone,
}: {
  wallet: RouteNodeInfo;
  makers: (RouteNodeInfo & { address: string })[];
  centerLabel: string;
  centerTone: RouteTone;
}) {
  const reduceMotion = useReducedMotion();
  const total = makers.length + 1;
  const nodes = [
    {
      id: "wallet",
      label: "Your Wallet",
      sub: undefined as string | undefined,
      icon: Wallet,
      info: wallet,
    },
    ...makers.map((m, i) => ({
      id: m.address,
      label: `Maker ${i + 1}`,
      sub: formatTorEndpoint(m.address, 8, 4, true),
      icon: Globe,
      info: m,
    })),
  ];
  const segments = Array.from({ length: total }, (_, i) => {
    const a = routeNodeXY(i, total);
    const b = routeNodeXY((i + 1) % total, total);
    // A true arc of the same circle the nodes sit on (not a bezier bulge) — with few nodes (e.g.
    // wallet + 2 makers) a bulging curve reads as a rounded triangle instead of a circle.
    const d = `M ${a.x} ${a.y} A ${ROUTE_RADIUS} ${ROUTE_RADIUS} 0 0 1 ${b.x} ${b.y}`;
    // Tint the arc by whichever endpoint is furthest along, so a segment glows once either side
    // of it has made progress rather than staying idle-gray until both ends finish.
    const toneRank: Record<RouteTone, number> = {
      idle: 0,
      active: 1,
      danger: 2,
      success: 3,
    };
    const destTone = nodes[(i + 1) % total].info.tone;
    const srcTone = nodes[i].info.tone;
    const tone = toneRank[destTone] >= toneRank[srcTone] ? destTone : srcTone;
    return { d, tone };
  });

  return (
    // Extra bottom space beyond the SVG/node-position math (ROUTE_SIZE square) so the label + pill
    // hanging below the bottommost node has room before the stats grid that follows this diagram.
    <div
      className="relative mx-auto"
      style={{ width: ROUTE_SIZE, height: ROUTE_SIZE + 56 }}
    >
      <svg
        width={ROUTE_SIZE}
        height={ROUTE_SIZE}
        className="absolute left-0 top-0"
        style={{ pointerEvents: "none" }}
      >
        {segments.map((seg, i) => (
          <motion.path
            key={i}
            d={seg.d}
            fill="none"
            strokeWidth={2.5}
            strokeLinecap="round"
            stroke="currentColor"
            className={ROUTE_TONE_BORDER[seg.tone]}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={
              seg.tone === "active"
                ? { pathLength: 1, opacity: [0.3, 0.85, 0.3] }
                : { pathLength: 1, opacity: seg.tone === "idle" ? 0.5 : 0.9 }
            }
            transition={
              seg.tone === "active"
                ? {
                    pathLength: { duration: 0.6, delay: i * 0.06 },
                    opacity: {
                      duration: 1.6,
                      repeat: reduceMotion ? 0 : Infinity,
                      ease: "easeInOut",
                      delay: reduceMotion ? 0 : i * 0.1,
                    },
                  }
                : { duration: 0.6, delay: i * 0.06 }
            }
          />
        ))}
      </svg>

      <div
        className="pointer-events-none absolute left-0 top-0 grid place-items-center"
        style={{ width: ROUTE_SIZE, height: ROUTE_SIZE }}
      >
        <AnimatePresence mode="wait">
          <motion.span
            key={centerLabel}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3 }}
            className={`font-header text-[14px] font-bold ${ROUTE_TONE_TEXT[centerTone]}`}
          >
            {centerLabel}
          </motion.span>
        </AnimatePresence>
      </div>

      {nodes.map((n, i) => {
        const { x, y } = routeNodeXY(i, total);
        const Icon = n.icon;
        const tone = n.info.tone;
        return (
          <motion.div
            key={n.id}
            initial={{
              opacity: reduceMotion ? 1 : 0,
              y: reduceMotion ? 0 : 10,
            }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.42,
              delay: reduceMotion ? 0 : i * 0.07,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="absolute flex flex-col items-center gap-1.5"
            style={{
              left: x - ROUTE_NODE_SIZE / 2,
              top: y - ROUTE_NODE_SIZE / 2,
              width: ROUTE_NODE_SIZE,
            }}
          >
            <div className="relative">
              {tone === "active" && (
                <motion.span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{ boxShadow: `0 0 18px ${ROUTE_TONE_GLOW[tone]}` }}
                  animate={{ opacity: reduceMotion ? 0.55 : [0.2, 0.8, 0.2] }}
                  transition={{
                    duration: 1.4,
                    repeat: reduceMotion ? 0 : Infinity,
                    ease: "easeInOut",
                  }}
                />
              )}
              <div
                className={`relative grid place-items-center rounded-full border-2 bg-surface-raised ${ROUTE_TONE_BORDER[tone]}`}
                style={{ width: ROUTE_NODE_SIZE, height: ROUTE_NODE_SIZE }}
              >
                <Icon size={26} strokeWidth={1.8} />
              </div>
            </div>
            <span className="text-center text-[10px] font-bold uppercase tracking-wide text-foreground">
              {n.label}
            </span>
            {n.sub && (
              <span className="font-mono text-[9px] text-subtle">{n.sub}</span>
            )}
            <StatusChip tone={ROUTE_STATUS_TONE[tone]}>
              {n.info.badge ?? ROUTE_TONE_LABEL[tone]}
            </StatusChip>
          </motion.div>
        );
      })}
    </div>
  );
}

export function SwapPage() {
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);
  const walletSyncStatus = useWalletCacheStore((s) => s.syncStatus);
  const walletSyncError = useWalletCacheStore((s) => s.syncError);
  const balances = useWalletCacheStore((s) => s.balances);
  const utxos = useWalletCacheStore((s) => s.utxos);

  const liquidity = useMemo<SwapLiquidity | null>(() => {
    if (!balances) return null;
    return {
      spendable: balances.spendable,
      regular: balances.regular,
      swap: balances.swap,
      maxSwappable:
        Math.max(balances.regular, balances.swap) -
        Math.min(3000, Math.max(balances.regular, balances.swap)),
    };
  }, [balances]);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [makers, setMakers] = useState<Maker[]>([]);
  const [fundingEstimate, setFundingEstimate] =
    useState<SwapFundingEstimate | null>(null);
  const [fundingEstimateStatus, setFundingEstimateStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");

  const [unit, setUnit] = useState<Unit>("sats");
  const [amountInput, setAmountInput] = useState("");
  const [utxoFilter, setUtxoFilter] = useState<UtxoFilter>("regular");
  const [selectedOutpoints, setSelectedOutpoints] = useState<Outpoint[]>([]);
  const [protocol, setProtocol] = useState<ProtocolVersion>("taproot");
  const [makerCount, setMakerCount] = useState(2);
  const [customMakerCount, setCustomMakerCount] = useState("5");
  const [selectedMakers, setSelectedMakers] = useState<string[]>([]);

  const [phase, setPhase] = useState<Lifecycle>("configure");
  const [summary, setSummary] = useState<SwapSummary | null>(null);
  const [swapId, setSwapId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<AppError | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(
    null,
  );
  const [tracker, setTracker] = useState<SwapTrackerProgress | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [swapLogs, setSwapLogs] = useState<LogLine[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);

  const loadReference = useCallback(async () => {
    const nextOffers = await getOffers();
    setMakers(nextOffers.good);
  }, []);

  useEffect(() => {
    void loadReference().catch((e) =>
      pushToast(
        "error",
        isAppError(e) ? e.message : "Failed to load swap data.",
      ),
    );
    // BTC/USD price is best-effort, same as Send — leave the USD unit disabled rather than toast.
    void getBtcPrice()
      .then((p) => setBtcPrice(p.usd))
      .catch(() => setBtcPrice(null));

    // Reconcile a swap already in flight (app restart mid-swap, or navigating back here).
    void getSwapProgress().then((progress) => {
      if (!progress) return;
      setSwapId(progress.swapId);
      setStartedAt(progress.startedAt ?? null);
      if (progress.phase === "finished") setPhase("finished");
      else if (progress.phase === "running" || progress.phase === "recovering")
        setPhase("running");
      else if (progress.phase === "failed") {
        setFailure(
          progress.error ? { code: "INTERNAL", message: progress.error } : null,
        );
        setPhase("failed");
      }
      // "prepared" has no cached SwapSummary to show on a confirm screen — leave on configure.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unlistenFinished: (() => void) | undefined;
    let unlistenFailed: (() => void) | undefined;
    void listen<string>("swap://finished", () => setPhase("finished")).then(
      (fn) => {
        unlistenFinished = fn;
      },
    );
    void listen<AppError>("swap://failed", (e) => {
      setFailure(e.payload);
      setPhase("failed");
    }).then((fn) => {
      unlistenFailed = fn;
    });
    return () => {
      unlistenFinished?.();
      unlistenFailed?.();
    };
  }, []);

  // Live per-maker detail straight off swap_tracker.cbor — same 2s poll cadence the old Electron
  // app used for its disk-read poll of the same file.
  useEffect(() => {
    if (phase !== "running") return;
    let cancelled = false;
    const poll = () => {
      void getSwapTracker()
        .then((next) => {
          if (!cancelled) setTracker(next);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase]);

  // One more read on the terminal transition — the last 2s-cadence poll can be a beat stale by
  // the time swap://finished|failed fires, so refresh once more for the final per-maker state.
  useEffect(() => {
    if (phase !== "finished" && phase !== "failed") return;
    void getSwapTracker()
      .then(setTracker)
      .catch(() => {});
  }, [phase]);

  // Backs the collapsed-by-default log panel below — same debug.log tail as the Logs page.
  // Gated on logsOpen too: no point polling a fetch nobody can see.
  useEffect(() => {
    if (!logsOpen) return;
    if (phase !== "running" && phase !== "finished" && phase !== "failed")
      return;
    let cancelled = false;
    const poll = () => {
      void getLogs(100)
        .then((next) => {
          if (!cancelled) setSwapLogs(next);
        })
        .catch(() => {});
    };
    poll();
    const id = phase === "running" ? setInterval(poll, 2000) : undefined;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [phase, logsOpen]);

  useEffect(() => {
    if (phase !== "failed") return;
    void getRecoveryStatus()
      .then(setRecoveryStatus)
      .catch(() => {});
  }, [phase]);

  function changeUnit(nextUnit: Unit) {
    const sats = unitStringToSats(amountInput, unit, btcPrice);
    setAmountInput(satsToUnitString(sats, nextUnit, btcPrice));
    setUnit(nextUnit);
  }

  const amountSats = useMemo(
    () => unitStringToSats(amountInput, unit, btcPrice),
    [amountInput, unit, btcPrice],
  );
  const otherUnits = useMemo(
    () => (["sats", "btc", "usd"] as Unit[]).filter((u) => u !== unit),
    [unit],
  );

  const spendableUtxos = useMemo(
    () => utxos.filter((u) => u.spendable && u.solvable),
    [utxos],
  );
  const filteredUtxos = useMemo(
    () =>
      spendableUtxos.filter(
        (u) =>
          classifySpendType(u.spendType) ===
          (utxoFilter === "regular" ? "Regular" : "Swap"),
      ),
    [spendableUtxos, utxoFilter],
  );
  const selectedUtxos = useMemo(() => {
    const set = new Set(selectedOutpoints.map((o) => `${o.txid}:${o.vout}`));
    return spendableUtxos.filter((u) => set.has(`${u.txid}:${u.vout}`));
  }, [selectedOutpoints, spendableUtxos]);
  const selectedTotal = useMemo(
    () => selectedUtxos.reduce((sum, u) => sum + u.amountSats, 0),
    [selectedUtxos],
  );

  function toggleOutpoint(u: UtxoEntry) {
    const key = `${u.txid}:${u.vout}`;
    setSelectedOutpoints((prev) => {
      const exists = prev.some((o) => `${o.txid}:${o.vout}` === key);
      if (exists) return prev.filter((o) => `${o.txid}:${o.vout}` !== key);
      return [...prev, { txid: u.txid, vout: u.vout }];
    });
  }

  // Never mix Regular/Swap UTXO kinds — switching the filter clears the other kind's selection.
  function changeUtxoFilter(next: UtxoFilter) {
    setUtxoFilter(next);
    setSelectedOutpoints([]);
  }

  const compatibleMakers = useMemo(
    () =>
      makers.filter((m) => {
        if (!m.offer) return false;
        const makerProtocol = m.protocol?.toLowerCase();
        // "unified" makers (the crate's current default) speak both — only a maker pinned to
        // the other protocol is actually incompatible.
        return (
          !makerProtocol ||
          makerProtocol === "unified" ||
          makerProtocol === protocol
        );
      }),
    [makers, protocol],
  );

  function pickMakerCount(count: number) {
    setMakerCount(count);
    setSelectedMakers([]);
  }

  function toggleMaker(address: string) {
    setSelectedMakers((prev) =>
      prev.includes(address)
        ? prev.filter((a) => a !== address)
        : [...prev, address],
    );
  }

  // Nothing ticked in the advanced panel means automatic — no separate mode flag to keep in sync.
  const manualCoins = selectedOutpoints.length > 0;
  const manualMakers = selectedMakers.length > 0;

  const effectiveMakerCount = manualMakers
    ? selectedMakers.length
    : makerCount === 5
      ? Math.max(2, Number(customMakerCount) || 5)
      : makerCount;

  const estimateMakers = useMemo(() => {
    if (manualMakers)
      return compatibleMakers.filter((m) => selectedMakers.includes(m.address));
    return compatibleMakers.slice(0, Math.max(0, effectiveMakerCount));
  }, [compatibleMakers, manualMakers, selectedMakers, effectiveMakerCount]);

  useEffect(() => {
    let cancelled = false;
    setFundingEstimate(null);
    setFundingEstimateStatus("idle");
    if (amountSats <= 0 || walletSyncStatus !== "synced")
      return () => {
        cancelled = true;
      };
    const timer = setTimeout(() => {
      setFundingEstimateStatus("loading");
      const outpoints =
        manualCoins && selectedOutpoints.length > 0
          ? selectedOutpoints
          : undefined;
      void estimateSwapFunding(amountSats, protocol, outpoints)
        .then((estimate) => {
          if (cancelled) return;
          setFundingEstimate(estimate);
          setFundingEstimateStatus("ready");
        })
        .catch(() => {
          if (cancelled) return;
          setFundingEstimate(null);
          setFundingEstimateStatus("error");
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [amountSats, protocol, manualCoins, selectedOutpoints, walletSyncStatus]);

  const feeSummary = useMemo(() => {
    const hasCompleteRoute =
      amountSats > 0 &&
      effectiveMakerCount > 0 &&
      estimateMakers.length === effectiveMakerCount;
    const makerFee = hasCompleteRoute
      ? estimateRouteMakerFees(
          estimateMakers.map((maker) => ({
            baseFee: maker.offer!.baseFee,
            amountRelativeFeePct: maker.offer!.amountRelativeFeePct,
            timeRelativeFeePct: maker.offer!.timeRelativeFeePct,
          })),
          amountSats,
        )
      : null;
    const fundingFee = fundingEstimate?.feeSats ?? null;
    const routeMiningFee = fundingEstimate
      ? fundingEstimate.routeMiningFeePerMakerSats * effectiveMakerCount
      : null;
    const sweepFee = fundingEstimate?.sweepFeeSats ?? null;
    // Everything the route takes out of the amount itself, as opposed to the funding fee,
    // which the wallet pays on top of it — hence `amount - deductions` for the receive
    // figure and `+ fundingFee` only for the total.
    const routeDeductions =
      makerFee !== null && routeMiningFee !== null && sweepFee !== null
        ? makerFee + routeMiningFee + sweepFee
        : null;
    const totalFee =
      routeDeductions !== null && fundingFee !== null
        ? routeDeductions + fundingFee
        : null;
    const receiveAmount =
      routeDeductions !== null ? Math.max(0, amountSats - routeDeductions) : null;
    return {
      makerFee,
      fundingFee,
      routeMiningFee,
      sweepFee,
      totalFee,
      receiveAmount,
    };
  }, [estimateMakers, effectiveMakerCount, amountSats, fundingEstimate]);

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (walletSyncStatus !== "synced") {
      list.push(
        walletSyncStatus === "error"
          ? `Wallet sync failed: ${walletSyncError ?? "The chain backend is unavailable."}`
          : "Wait for the initial wallet sync before starting a swap.",
      );
    }
    if (fundingEstimateStatus === "error") {
      list.push(
        "The wallet could not calculate a funding transaction for this amount and coin selection.",
      );
    }
    if (amountInput.length > 0 && amountSats <= 0)
      list.push("Enter a valid amount.");
    if (amountSats > 0 && liquidity && amountSats > liquidity.maxSwappable)
      list.push("Amount exceeds your swappable balance.");
    if (manualCoins && selectedTotal < amountSats)
      list.push("Selected UTXOs don't cover the swap amount.");
    if (
      amountSats > 0 &&
      feeSummary.receiveAmount !== null &&
      feeSummary.receiveAmount < 10_000
    ) {
      list.push("Estimated receive amount is too small after fees.");
    }
    if (manualMakers && selectedMakers.length < 2) {
      list.push("Pin at least two makers, or untick them all to auto-select.");
    } else if (effectiveMakerCount < 2) {
      list.push("A Portal route requires at least two makers.");
    }
    if (compatibleMakers.length === 0) {
      list.push(`No compatible ${protocol} makers found in the offerbook.`);
    } else if (!manualMakers && effectiveMakerCount > compatibleMakers.length) {
      list.push(
        `Only ${compatibleMakers.length} compatible maker${compatibleMakers.length === 1 ? "" : "s"} available for ${effectiveMakerCount} hops.`,
      );
    }
    return list;
  }, [
    amountInput,
    amountSats,
    liquidity,
    manualCoins,
    selectedOutpoints,
    selectedTotal,
    feeSummary.receiveAmount,
    manualMakers,
    selectedMakers,
    compatibleMakers,
    effectiveMakerCount,
    protocol,
    walletSyncStatus,
    walletSyncError,
    fundingEstimateStatus,
  ]);

  // Null once the quote is ready: the numbers underneath already are the quote.
  const quoteStatus =
    walletSyncStatus !== "synced"
      ? "Waiting for wallet sync"
      : fundingEstimateStatus === "loading"
        ? "Calculating wallet quote"
        : fundingEstimateStatus === "error"
          ? "Quote unavailable"
          : fundingEstimate
            ? null
            : "";

  // Pinned makers already show up in the Makers section; a UTXO pick has no other home.
  const advancedSummary = manualCoins
    ? `${selectedOutpoints.length} UTXO${selectedOutpoints.length === 1 ? "" : "s"} selected`
    : null;

  const canStart =
    amountSats > 0 &&
    fundingEstimate !== null &&
    warnings.length === 0 &&
    !submitting;

  // prepareSwap + startSwap in one action — the crate's negotiated SwapSummary is shown on the
  // progress screen itself rather than gating on a separate confirm click (see also §3.2 of the
  // design notes, which suggested a confirm step; kept as one action per direct product feedback).
  async function handleStartSwap() {
    if (useWalletCacheStore.getState().syncStatus !== "synced") {
      pushToast(
        "error",
        "Wait for wallet synchronization before starting a swap.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const request: SwapRequest = {
        protocol,
        amountSats,
        makerCount: effectiveMakerCount,
        outpoints:
          manualCoins && selectedOutpoints.length > 0
            ? selectedOutpoints
            : undefined,
        preferredMakers:
          manualMakers && selectedMakers.length > 0
            ? selectedMakers
            : undefined,
      };
      const prepared = await prepareSwap(request);
      setSummary(prepared);
      setSwapId(prepared.swapId);
      await startSwap(prepared.swapId);
      setStartedAt(Math.floor(Date.now() / 1000));
      setPhase("running");
    } catch (e) {
      const err = isAppError(e) ? e : null;
      pushToast("error", err?.message ?? "Failed to start swap.");
    } finally {
      setSubmitting(false);
    }
  }

  function resetWizard() {
    setPhase("configure");
    setSummary(null);
    setSwapId(null);
    setStartedAt(null);
    setFailure(null);
    setRecoveryStatus(null);
    setTracker(null);
    setAmountInput("");
    setSelectedOutpoints([]);
    setSelectedMakers([]);
    void loadReference().catch(() => {});
  }

  async function handleRecover() {
    setRecovering(true);
    try {
      await recoverSwap();
      pushToast("success", "Recovery started.");
      setRecoveryStatus(await getRecoveryStatus());
    } catch (e) {
      const err = isAppError(e) ? e : null;
      pushToast("error", err?.message ?? "Recovery failed to start.");
    } finally {
      setRecovering(false);
    }
  }

  if (phase === "running" || phase === "finished" || phase === "failed") {
    const contractsBroadcasted = failure?.code === "CONTRACTS_BROADCASTED";

    // Navigating away and back remounts this component, resetting `summary` to null — it only
    // ever comes from prepareSwap's return value, which can't be re-fetched for an already-running
    // swap. Fall back to the live tracker (which survives remounts fine, since it's a fresh read
    // off disk each time) so the screen doesn't get stuck "reconnecting" forever.
    const makerAddresses =
      summary?.makers.map((m) => m.address) ??
      tracker?.makers.map((m) => m.address) ??
      null;
    const displaySendAmountSats =
      summary?.sendAmountSats ?? tracker?.sendAmountSats;
    const displayMakerCount = summary?.makers.length ?? tracker?.makerCount;

    const makerNodes: (RouteNodeInfo & { address: string })[] = (
      makerAddresses ?? []
    ).map((address) => {
      if (phase === "finished") return { address, tone: "success" };
      if (phase === "failed") return { address, tone: "danger" };
      const live = tracker?.makers.find((tm) => tm.address === address);
      if (!live) return { address, tone: "idle" };
      return { address, tone: stepsToTone(live.stepsDone, live.stepsTotal) };
    });

    const walletNode: RouteNodeInfo =
      phase === "finished"
        ? { tone: "success", badge: "Received" }
        : phase === "failed"
          ? { tone: "danger" }
          : {
              tone:
                tracker && tracker.phase !== "makers_discovered"
                  ? "active"
                  : "idle",
            };

    const centerLabel =
      phase === "finished"
        ? "Swap Complete"
        : phase === "failed"
          ? "Swap Failed"
          : tracker
            ? TRACKER_PHASE_LABEL[tracker.phase]
            : "Swapping…";
    const centerTone: RouteTone =
      phase === "finished"
        ? "success"
        : phase === "failed"
          ? "danger"
          : "active";

    return (
      <div className="flex h-full flex-col items-center overflow-y-auto px-8 py-10">
        <div className="w-full max-w-2xl">
          <div className="flex items-center justify-center gap-3">
            {phase === "running" && (
              <RefreshCw
                size={30}
                strokeWidth={1.8}
                className="animate-spin text-primary"
              />
            )}
            {phase === "finished" && (
              <CheckCircle2
                size={30}
                strokeWidth={1.8}
                className="text-success"
              />
            )}
            {phase === "failed" && (
              <XCircle size={30} strokeWidth={1.8} className="text-danger" />
            )}
            <h1 className="font-header text-[26px] font-bold text-foreground">
              {phase === "running" && "Swap in progress"}
              {phase === "finished" && "Swap Complete"}
              {phase === "failed" && "Swap Failed"}
            </h1>
          </div>

          <Card className="mt-5 flex flex-col gap-4 border-line-strong p-6">
            {makerAddresses ? (
              <SwapRouteAnimation
                wallet={walletNode}
                makers={makerNodes}
                centerLabel={centerLabel}
                centerTone={centerTone}
              />
            ) : (
              <div className="grid min-h-[220px] place-items-center gap-2.5 text-center text-[13px] text-subtle">
                <RefreshCw
                  size={32}
                  strokeWidth={1.6}
                  className="animate-spin text-primary"
                />
                <span>Loading swap progress…</span>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3 rounded-control border border-line-strong bg-surface-raised px-3.5 py-3 text-center">
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                  Amount
                </div>
                <div className="mt-1 font-mono text-[13px] font-semibold text-foreground">
                  {displaySendAmountSats !== undefined
                    ? displaySendAmountSats.toLocaleString()
                    : "—"}
                </div>
              </div>
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                  Makers
                </div>
                <div className="mt-1 font-mono text-[13px] font-semibold text-foreground">
                  {displayMakerCount !== undefined ? displayMakerCount : "—"}
                </div>
              </div>
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                  Elapsed
                </div>
                <div className="mt-1 font-mono text-[13px] font-semibold text-foreground">
                  <Elapsed startedAt={startedAt} active={phase === "running"} />
                </div>
              </div>
            </div>

            {phase === "finished" && summary && (
              <AmountTile label="Received">
                <SatsAmount sats={summary.estimatedReceiveAmountSats} />
              </AmountTile>
            )}

            {phase === "failed" && (
              <div className="flex flex-col gap-2.5 rounded-control border border-danger/35 bg-danger/[0.06] px-3.5 py-3">
                <div className="flex items-start gap-2 text-[12px] text-danger">
                  <ShieldAlert
                    size={15}
                    strokeWidth={2}
                    className="mt-0.5 flex-none"
                  />
                  <span>
                    {contractsBroadcasted
                      ? "Funds are on-chain and safe — recovery has already started automatically."
                      : (tracker?.failureReason ??
                        failure?.message ??
                        "Something went wrong.")}
                  </span>
                </div>
                {recoveryStatus &&
                  (recoveryStatus.recovering ||
                    recoveryStatus.pendingContractCount > 0) && (
                    <div className="flex items-center justify-between text-[11.5px] text-subtle">
                      <span>
                        {recoveryStatus.complete
                          ? "Recovery complete."
                          : `Recovering ${recoveryStatus.pendingContractCount} pending contract${recoveryStatus.pendingContractCount === 1 ? "" : "s"}...`}
                      </span>
                      {!recoveryStatus.complete &&
                        !recoveryStatus.recovering && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleRecover()}
                            loading={recovering}
                          >
                            Recover Now
                          </Button>
                        )}
                    </div>
                  )}
              </div>
            )}

            {(phase === "finished" || phase === "failed") && (
              <div className="flex gap-2.5">
                <Button variant="secondary" className="flex-1" onClick={resetWizard}>
                  Back to Swap Page
                </Button>
                {swapId && (
                  <Button
                    className="flex-1"
                    onClick={() =>
                      navigate(`/swap/reports/${encodeURIComponent(swapId)}`)
                    }
                  >
                    View Report
                  </Button>
                )}
              </div>
            )}

            <Disclosure label="Swap Log" onOpenChange={setLogsOpen}>
              <div className="rounded-control border border-line bg-surface-raised">
                <LogViewer lines={swapLogs} className="max-h-64" />
              </div>
            </Disclosure>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 pb-8 pt-2">
      <div className="flex shrink-0 items-start justify-between gap-3 pb-4">
        <div>
          <h1 className="font-header text-[26px] font-bold text-foreground">
            Initiate Swap
          </h1>
          <p className="mt-1 text-[13.5px] text-muted">
            Route a private Bitcoin swap through multiple makers over Tor.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate("/swap/reports")}
        >
          <FileText size={14} strokeWidth={2} />
          Swap Reports
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="flex flex-col gap-5 border-line-strong p-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-primary/40 bg-primary/[0.08] text-primary">
              <ArrowLeftRight size={15} strokeWidth={2} />
            </span>
            <h2 className="font-header text-[15px] font-bold text-foreground">
              Amount To Swap
            </h2>
          </div>

          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <TextField
                label="Amount"
                inputMode="decimal"
                placeholder="0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
              />
              <SegmentedToggle
                groupId="swap-unit"
                value={unit}
                onChange={changeUnit}
                options={[
                  { value: "sats", label: "sats" },
                  { value: "btc", label: "BTC" },
                  {
                    value: "usd",
                    label: "USD",
                    disabled: btcPrice === null,
                    title:
                      btcPrice === null ? "BTC price unavailable" : undefined,
                  },
                ]}
              />
            </div>
            <div className="flex items-center justify-between px-1 text-[11px] text-subtle">
              <div className="flex items-center gap-4">
                <span>
                  {formatUnitAmount(amountSats, otherUnits[0], btcPrice) ?? "—"}
                </span>
                <span>
                  {formatUnitAmount(amountSats, otherUnits[1], btcPrice) ?? "—"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setUnit("sats");
                  setAmountInput(String(liquidity?.maxSwappable ?? 0));
                }}
                className="flex items-center gap-1 font-semibold text-primary hover:text-primary-hover"
              >
                Use max swappable:{" "}
                <SatsAmount sats={liquidity?.maxSwappable ?? 0} />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-5">
            <h2 className="font-header text-[13.5px] font-bold text-foreground">
              Protocol
            </h2>
            <SegmentedToggle
              groupId="swap-protocol"
              value={protocol}
              onChange={setProtocol}
              options={[
                { value: "taproot", label: "Taproot" },
                { value: "legacy", label: "Legacy" },
              ]}
            />
          </div>

          <div className="flex flex-col gap-2.5 border-t border-line pt-5">
            <div className="flex items-center justify-between">
              <h2 className="font-header text-[13.5px] font-bold text-foreground">
                Makers
              </h2>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                {effectiveMakerCount} from {compatibleMakers.length} available
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {MAKER_COUNT_PRESETS.map((n) => (
                <PresetTile
                  key={n}
                  onClick={() => pickMakerCount(n)}
                  selected={!manualMakers && makerCount === n}
                  label="Makers"
                  value={n}
                />
              ))}
              <PresetTile
                onClick={() => pickMakerCount(5)}
                selected={!manualMakers && makerCount === 5}
                label="Custom"
                value="5+"
              />
            </div>
            {!manualMakers && makerCount === 5 && (
              <TextField
                label="Number of makers"
                inputMode="numeric"
                value={customMakerCount}
                onChange={(e) => setCustomMakerCount(e.target.value)}
              />
            )}
            <p className="text-[11.5px] text-subtle">
              {manualMakers
                ? `Route pinned to ${selectedMakers.length} specific maker${selectedMakers.length === 1 ? "" : "s"} in advanced options — pick a count to go back to automatic.`
                : "More makers means stronger privacy and higher fees."}
            </p>
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-5">
            <Disclosure label="Advanced options" onOpenChange={setAdvancedOpen}>
              <div className="flex flex-col gap-5 pt-1">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-header text-[12.5px] font-bold text-foreground">
                      Pin Specific Makers
                    </h3>
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                      {manualMakers
                        ? `${selectedMakers.length} pinned`
                        : "Automatic"}
                    </span>
                  </div>
                  <p className="text-[11.5px] text-subtle">
                    Tick makers to route through them specifically, or leave
                    them all unticked to auto-select.
                  </p>
                  <div className="flex max-h-45 flex-col gap-1.5 overflow-y-auto">
                    {compatibleMakers.length === 0 && (
                      <p className="text-[11.5px] text-subtle">
                        No compatible {protocol} makers in the offerbook.
                      </p>
                    )}
                    {compatibleMakers.map((m) => (
                      <label
                        key={m.address}
                        className="flex cursor-pointer items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3 py-2"
                      >
                        <span className="flex items-center gap-2 truncate font-mono text-[11px] text-muted">
                          <input
                            type="checkbox"
                            checked={selectedMakers.includes(m.address)}
                            onChange={() => toggleMaker(m.address)}
                            className="accent-primary"
                          />
                          {formatTorEndpoint(m.address, 10, 6, true)}
                        </span>
                        <span className="flex flex-none items-center gap-2 font-mono text-[11px] text-subtle">
                          {m.offer?.amountRelativeFeePct.toFixed(3)}%
                          <SatsAmount
                            sats={m.offer?.bondAmountSats ?? 0}
                            className="text-foreground"
                          />
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2.5 border-t border-line pt-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-header text-[12.5px] font-bold text-foreground">
                      Coin Selection
                    </h3>
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                      {manualCoins
                        ? `${selectedOutpoints.length} selected`
                        : "Automatic"}
                    </span>
                  </div>
                  <p className="text-[11.5px] text-subtle">
                    Tick the UTXOs to fund this swap, or leave them all unticked
                    to let the wallet choose.
                  </p>
                  <SegmentedToggle
                    groupId="swap-utxo-filter"
                    value={utxoFilter}
                    onChange={changeUtxoFilter}
                    options={[
                      { value: "regular", label: "Regular" },
                      { value: "swap", label: "Swap" },
                    ]}
                  />
                  <div className="flex max-h-45 flex-col gap-1.5 overflow-y-auto">
                    {filteredUtxos.length === 0 && (
                      <p className="text-[11.5px] text-subtle">
                        No spendable {utxoFilter} UTXOs.
                      </p>
                    )}
                    {filteredUtxos.map((u) => {
                      const key = `${u.txid}:${u.vout}`;
                      const checked = selectedOutpoints.some(
                        (o) => `${o.txid}:${o.vout}` === key,
                      );
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3 py-2"
                        >
                          <span className="flex items-center gap-2 truncate font-mono text-[11px] text-muted">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleOutpoint(u)}
                              className="accent-primary"
                            />
                            {truncateMiddle(u.txid, 8, 6)}:{u.vout}
                          </span>
                          <SatsAmount
                            sats={u.amountSats}
                            className="flex-none text-[11px] font-semibold text-foreground"
                          />
                        </label>
                      );
                    })}
                  </div>
                  {manualCoins && (
                    <p className="text-[11.5px] text-subtle">
                      Selected:{" "}
                      <SatsAmount
                        sats={selectedTotal}
                        className="text-foreground"
                      />
                    </p>
                  )}
                </div>
              </div>
            </Disclosure>
            {/* Advanced picks survive collapsing the panel, so they'd otherwise be invisible. */}
            {!advancedOpen && advancedSummary && (
              <p className="px-1 text-[11.5px] text-subtle">
                {advancedSummary}
              </p>
            )}
          </div>

          {warnings.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-control border border-warning/35 bg-warning/[0.08] px-3.5 py-2.5">
              {warnings.map((w) => (
                <div
                  key={w}
                  className="flex items-start gap-2 text-[12px] text-warning"
                >
                  <AlertTriangle
                    size={13}
                    strokeWidth={2}
                    className="mt-0.5 flex-none"
                  />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          <Button
            size="md"
            disabled={!canStart}
            loading={submitting}
            onClick={() => void handleStartSwap()}
          >
            Start Swap
          </Button>
          {submitting && (
            <p className="-mt-2 text-center text-[11.5px] text-subtle">
              Negotiating with makers over Tor — this can take up to a minute.
            </p>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="border-line-strong p-5">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
              Swappable Balance
            </span>
            <div className="mt-1.5">
              <SatsAmount
                sats={liquidity?.maxSwappable ?? 0}
                className="text-[26px] font-bold text-primary"
              />
            </div>
            <p className="mt-1 text-[12px] text-muted">
              {liquidity
                ? `${(liquidity.maxSwappable / SATS_PER_BTC).toFixed(8)} BTC`
                : "…"}
            </p>
          </Card>

          <Card className="flex flex-col gap-3 border-line-strong p-5">
            <div className="flex items-center justify-between">
              <h3 className="font-header text-[14px] font-bold text-foreground">
                Swap Summary
              </h3>
              {quoteStatus && (
                <span className="rounded-pill border border-primary/35 bg-primary/[0.08] px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-primary">
                  {quoteStatus}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-subtle">Swap amount</span>
                <SatsAmount
                  sats={amountSats}
                  className="font-semibold text-foreground"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-subtle">Makers</span>
                <strong className="font-mono text-foreground">
                  {effectiveMakerCount}
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-subtle">Funding inputs</span>
                <strong className="font-mono text-foreground">
                  {fundingEstimate?.inputCount ?? "—"}
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-subtle">Funding tx size</span>
                <strong className="font-mono text-foreground">
                  {fundingEstimate ? `${fundingEstimate.vbytes} vB` : "—"}
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-subtle">Funding tx fee</span>
                <EstimatedSats
                  sats={feeSummary.fundingFee}
                  className="font-semibold text-foreground"
                />
              </div>
            </div>

            {/* The three rows below the divider are what comes out of the amount, so they read
                straight down into "You receive"; the funding fee sits above it with its own tx. */}
            <div className="flex flex-col gap-1.5 border-t border-dashed border-line pt-3 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-subtle">Maker fees</span>
                <EstimatedSats
                  sats={feeSummary.makerFee}
                  className="font-semibold text-foreground"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-subtle">Route mining fees</span>
                <EstimatedSats
                  sats={feeSummary.routeMiningFee}
                  className="font-semibold text-foreground"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-subtle">Claim tx fee</span>
                <EstimatedSats
                  sats={feeSummary.sweepFee}
                  className="font-semibold text-foreground"
                />
              </div>
              <div className="flex items-center justify-between border-t border-line pt-1.5">
                <span className="text-subtle">Total cost</span>
                <EstimatedSats
                  sats={feeSummary.totalFee}
                  className="font-bold text-primary"
                />
              </div>
            </div>

            <AmountTile label="You receive">
              <EstimatedSats
                sats={feeSummary.receiveAmount}
                className="text-success"
              />
            </AmountTile>
          </Card>
        </div>
      </div>
    </div>
  );
}
