import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  FileText,
  RefreshCw,
  ShieldAlert,
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
  Router,
  Outpoint,
  ProtocolVersion,
  RecoveryStatus,
  SwapLiquidity,
  SwapFundingEstimate,
  SwapRequest,
  SwapSummary,
  SwapTrackerProgress,
  UtxoEntry,
} from "../../api/types";
import {
  AmountTile,
  Card,
  Disclosure,
  LogViewer,
  SatsAmount,
} from "../../components/ui/display";
import {
  Button,
  PresetTile,
  SegmentedToggle,
  TextField,
} from "../../components/ui/inputs";
import { SwapCircuit } from "./circuit/SwapCircuit";
import { NowPanel, Vitals } from "./circuit/panels";
import { useSwapCircuit } from "./circuit/useSwapCircuit";
import {
  estimateRouteRouterFees,
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

const ROUTER_COUNT_PRESETS = [2, 3, 4] as const;

function elapsedLabel(startedAt: number | null): string {
  if (!startedAt) return "0s";
  return formatDuration(Date.now() / 1000 - startedAt);
}

// Owns its own 1s tick so the rest of the progress screen (circuit diagram, Motion props
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
  const [btcPriceCached, setBtcPriceCached] = useState(false);
  const [routers, setRouters] = useState<Router[]>([]);
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
  const [routerCount, setRouterCount] = useState(2);
  const [customRouterCount, setCustomRouterCount] = useState("5");
  const [selectedRouters, setSelectedRouters] = useState<string[]>([]);

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

  const circuit = useSwapCircuit(tracker, summary, phase === "failed");

  const loadReference = useCallback(async () => {
    const nextOffers = await getOffers();
    setRouters(nextOffers.good);
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
      .then((p) => {
        setBtcPrice(p.usd);
        setBtcPriceCached(p.cached);
      })
      .catch(() => {
        setBtcPrice(null);
        setBtcPriceCached(false);
      });

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

  // Live per-router detail straight off swap_tracker.cbor — same 2s poll cadence the old Electron
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
  // the time swap://finished|failed fires, so refresh once more for the final per-router state.
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

  const compatibleRouters = useMemo(
    () =>
      routers.filter((m) => {
        if (!m.offer) return false;
        const routerProtocol = m.protocol?.toLowerCase();
        // "unified" routers (the crate's current default) speak both — only a router pinned to
        // the other protocol is actually incompatible.
        return (
          !routerProtocol ||
          routerProtocol === "unified" ||
          routerProtocol === protocol
        );
      }),
    [routers, protocol],
  );

  function pickRouterCount(count: number) {
    setRouterCount(count);
    setSelectedRouters([]);
  }

  function toggleRouter(address: string) {
    setSelectedRouters((prev) =>
      prev.includes(address)
        ? prev.filter((a) => a !== address)
        : [...prev, address],
    );
  }

  // Nothing ticked in the advanced panel means automatic — no separate mode flag to keep in sync.
  const manualCoins = selectedOutpoints.length > 0;
  const manualRouters = selectedRouters.length > 0;

  const effectiveRouterCount = manualRouters
    ? selectedRouters.length
    : routerCount === 5
      ? Math.max(2, Number(customRouterCount) || 5)
      : routerCount;

  const estimateRouters = useMemo(() => {
    if (manualRouters)
      return compatibleRouters.filter((m) => selectedRouters.includes(m.address));
    return compatibleRouters.slice(0, Math.max(0, effectiveRouterCount));
  }, [compatibleRouters, manualRouters, selectedRouters, effectiveRouterCount]);

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
      effectiveRouterCount > 0 &&
      estimateRouters.length === effectiveRouterCount;
    const routerFee = hasCompleteRoute
      ? estimateRouteRouterFees(
          estimateRouters.map((router) => ({
            baseFee: router.offer!.baseFee,
            amountRelativeFeePct: router.offer!.amountRelativeFeePct,
            timeRelativeFeePct: router.offer!.timeRelativeFeePct,
          })),
          amountSats,
        )
      : null;
    const fundingFee = fundingEstimate?.feeSats ?? null;
    const routeMiningFee = fundingEstimate
      ? fundingEstimate.routeMiningFeePerRouterSats * effectiveRouterCount
      : null;
    const sweepFee = fundingEstimate?.sweepFeeSats ?? null;
    // Everything the route takes out of the amount itself, as opposed to the funding fee,
    // which the wallet pays on top of it — hence `amount - deductions` for the receive
    // figure and `+ fundingFee` only for the total.
    const routeDeductions =
      routerFee !== null && routeMiningFee !== null && sweepFee !== null
        ? routerFee + routeMiningFee + sweepFee
        : null;
    const totalFee =
      routeDeductions !== null && fundingFee !== null
        ? routeDeductions + fundingFee
        : null;
    const receiveAmount =
      routeDeductions !== null ? Math.max(0, amountSats - routeDeductions) : null;
    return {
      routerFee,
      fundingFee,
      routeMiningFee,
      sweepFee,
      totalFee,
      receiveAmount,
    };
  }, [estimateRouters, effectiveRouterCount, amountSats, fundingEstimate]);

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
    if (manualRouters && selectedRouters.length < 2) {
      list.push("Pin at least two routers, or untick them all to auto-select.");
    } else if (effectiveRouterCount < 2) {
      list.push("A Portal route requires at least two routers.");
    }
    if (compatibleRouters.length === 0) {
      list.push(`No compatible ${protocol} routers found in the offerbook.`);
    } else if (!manualRouters && effectiveRouterCount > compatibleRouters.length) {
      list.push(
        `Only ${compatibleRouters.length} compatible router${compatibleRouters.length === 1 ? "" : "s"} available for ${effectiveRouterCount} hops.`,
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
    manualRouters,
    selectedRouters,
    compatibleRouters,
    effectiveRouterCount,
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

  // Pinned routers already show up in the Routers section; a UTXO pick has no other home.
  const advancedSummary = manualCoins
    ? `${selectedOutpoints.length} UTXO${selectedOutpoints.length === 1 ? "" : "s"} selected`
    : null;

  const canStart =
    amountSats > 0 &&
    fundingEstimate !== null &&
    warnings.length === 0 &&
    !submitting;

  // prepareSwap + startSwap is one renderer action. startSwap owns the single native approval
  // dialog, bound to the authoritative prepared summary; there is no second renderer modal.
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
        routerCount: effectiveRouterCount,
        outpoints:
          manualCoins && selectedOutpoints.length > 0
            ? selectedOutpoints
            : undefined,
        preferredRouters:
          manualRouters && selectedRouters.length > 0
            ? selectedRouters
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
      if (err?.code !== "AUTHORIZATION_DENIED" && err?.code !== "USER_CANCELLED") {
        pushToast("error", err?.message ?? "Failed to start swap.");
      }
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
    setSelectedRouters([]);
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
    const routeKnown =
      (summary?.routers.length ?? tracker?.routers.length ?? 0) > 0 ||
      tracker !== null;
    const displaySendAmountSats =
      summary?.sendAmountSats ?? tracker?.sendAmountSats;

    return (
      <div className="flex h-full flex-col items-center overflow-y-auto px-8 py-10">
        <div className="w-full max-w-4xl">
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
            {routeKnown ? (
              <div className="flex flex-col gap-4">
                <SwapCircuit view={circuit} />
                <Vitals
                  view={circuit}
                  elapsedSeconds={startedAt === null ? null : Date.now() / 1000 - startedAt}
                  blockHeight={null}
                />
                <NowPanel view={circuit} />
              </div>
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

            <div className="grid grid-cols-2 gap-3 rounded-control border border-line-strong bg-surface-raised px-3.5 py-3 text-center">
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
                <LogViewer lines={swapLogs} className="max-h-64" newestFirst />
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
            Route a private Bitcoin swap through multiple routers over Tor.
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
                      btcPrice === null
                        ? "BTC price unavailable"
                        : btcPriceCached
                          ? "Using the last saved BTC price because the live update failed"
                          : undefined,
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
                Routers
              </h2>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                {effectiveRouterCount} from {compatibleRouters.length} available
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {ROUTER_COUNT_PRESETS.map((n) => (
                <PresetTile
                  key={n}
                  onClick={() => pickRouterCount(n)}
                  selected={!manualRouters && routerCount === n}
                  label="Routers"
                  value={n}
                />
              ))}
              <PresetTile
                onClick={() => pickRouterCount(5)}
                selected={!manualRouters && routerCount === 5}
                label="Custom"
                value="5+"
              />
            </div>
            {!manualRouters && routerCount === 5 && (
              <TextField
                label="Number of routers"
                inputMode="numeric"
                value={customRouterCount}
                onChange={(e) => setCustomRouterCount(e.target.value)}
              />
            )}
            <p className="text-[11.5px] text-subtle">
              {manualRouters
                ? `Route pinned to ${selectedRouters.length} specific router${selectedRouters.length === 1 ? "" : "s"} in advanced options — pick a count to go back to automatic.`
                : "More routers means stronger privacy and higher fees."}
            </p>
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-5">
            <Disclosure label="Advanced options" onOpenChange={setAdvancedOpen}>
              <div className="flex flex-col gap-5 pt-1">
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-header text-[12.5px] font-bold text-foreground">
                      Pin Specific Routers
                    </h3>
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                      {manualRouters
                        ? `${selectedRouters.length} pinned`
                        : "Automatic"}
                    </span>
                  </div>
                  <p className="text-[11.5px] text-subtle">
                    Tick routers to route through them specifically, or leave
                    them all unticked to auto-select.
                  </p>
                  <div className="flex max-h-45 flex-col gap-1.5 overflow-y-auto">
                    {compatibleRouters.length === 0 && (
                      <p className="text-[11.5px] text-subtle">
                        No compatible {protocol} routers in the offerbook.
                      </p>
                    )}
                    {compatibleRouters.map((m) => (
                      <label
                        key={m.address}
                        className="flex cursor-pointer items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3 py-2"
                      >
                        <span className="flex items-center gap-2 truncate font-mono text-[11px] text-muted">
                          <input
                            type="checkbox"
                            checked={selectedRouters.includes(m.address)}
                            onChange={() => toggleRouter(m.address)}
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
              Negotiating with routers over Tor — this can take up to a minute.
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
                <span className="text-subtle">Routers</span>
                <strong className="font-mono text-foreground">
                  {effectiveRouterCount}
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
                <span className="text-subtle">Router fees</span>
                <EstimatedSats
                  sats={feeSummary.routerFee}
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
