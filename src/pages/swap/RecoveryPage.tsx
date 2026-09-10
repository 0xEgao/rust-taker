import { AlertTriangle, ArrowRight, CheckCircle2, Clock, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getLogs, getRecoveryStatus, getSwapTracker, recoverSwap } from "../../api/commands";
import { isAppError } from "../../api/types";
import type {
  LogLine,
  RecoveryContract,
  RecoveryStatus,
  SwapTrackerProgress,
} from "../../api/types";
import {
  BackButton,
  Card,
  CopyButton,
  Disclosure,
  EmptyState,
  ExternalLinkButton,
  LogViewer,
  Notice,
  SatsAmount,
  StatusChip,
} from "../../components/ui/display";
import { Button } from "../../components/ui/inputs";
import { Checklist, type CheckState } from "../../components/ui/Checklist";
import { truncateMiddle } from "../../lib/wallet-format";
import { useToastStore } from "../../store/toast";
import { SwapCircuit } from "./circuit/SwapCircuit";
import { useSwapCircuit } from "./circuit/useSwapCircuit";

// The crate's recovery loop retries once a minute, so anything faster only re-reads the same file.
const POLL_MS = 12_000;
const MINUTES_PER_BLOCK = 10;

function wait(blocks: number) {
  const minutes = blocks * MINUTES_PER_BLOCK;
  if (minutes < 90) return `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
}

function ContractRow({ contract }: { contract: RecoveryContract }) {
  const blocks = contract.blocksRemaining;
  const waiting = blocks !== undefined && blocks > 0;
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <span className="flex min-w-0 flex-col gap-1.5">
        <span
          className="truncate font-mono text-[12px] text-muted"
          title={`${contract.outpoint.txid}:${contract.outpoint.vout}`}
        >
          {truncateMiddle(contract.outpoint.txid, 10, 6)}:{contract.outpoint.vout}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusChip tone={waiting ? "warning" : "primary"} className="self-start">
            {contract.claimPath === "hashlock"
              ? "Claimable now"
              : waiting
                ? `Locked for ~${blocks} more blocks`
                : "Lock expired — claiming"}
          </StatusChip>
          {contract.confirmations === 0 && (
            <StatusChip tone="subtle" className="self-start">
              In the mempool
            </StatusChip>
          )}
        </span>
      </span>
      <span className="flex flex-none items-center gap-2">
        <span className="font-numeric text-[12.5px] text-foreground">
          <SatsAmount sats={contract.amountSats} />
        </span>
        <ExternalLinkButton txid={contract.outpoint.txid} />
      </span>
    </div>
  );
}

export function RecoveryPage() {
  const pushToast = useToastStore((s) => s.push);
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [tracker, setTracker] = useState<SwapTrackerProgress | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const next = await getRecoveryStatus();
    setStatus(next);
    if (next.swapId) setTracker(await getSwapTracker(next.swapId));
  }, []);

  useEffect(() => {
    void load().catch(() => {});
    const id = setInterval(() => void load().catch(() => {}), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!logsOpen) return;
    void getLogs(120).then(setLogs).catch(() => {});
  }, [logsOpen]);

  const circuit = useSwapCircuit(tracker, null, true);

  async function checkNow() {
    setChecking(true);
    try {
      await recoverSwap();
      pushToast("success", "Recovery restarted.");
      await load();
    } catch (e) {
      pushToast("error", isAppError(e) ? e.message : "Could not start recovery.");
    } finally {
      setChecking(false);
    }
  }

  if (status && !status.active) {
    return (
      <div className="h-full overflow-y-auto px-8 py-10">
        <div className="mx-auto w-full max-w-4xl">
          <BackButton to="/swap" label="Back to Swap" />
          <EmptyState
            icon={<CheckCircle2 size={22} strokeWidth={1.8} />}
            title="Nothing to recover"
            description="No swap has funds sitting in a contract. If a swap stops after its funding transaction is broadcast, Portal claims the funds back and this page tracks it."
          />
        </div>
      </div>
    );
  }

  const blocks = status?.blocksRemaining;
  const waiting = blocks !== undefined && blocks > 0;
  const claimableNow = (status?.pending ?? []).filter(
    (c) => c.claimPath === "hashlock" || (c.blocksRemaining ?? 0) === 0,
  );
  const resolvedCount = status?.resolved.length ?? 0;
  const pendingCount = status?.pending.length ?? 0;

  // The three things that actually happen, in order. Each state is read off the contracts rather
  // than a timer: the crate writes no progress until a claim lands.
  const steps: { label: string; state: CheckState }[] = [
    {
      label: "Funds identified in their contracts",
      state: pendingCount > 0 || resolvedCount > 0 ? "passed" : "running",
    },
    {
      label: waiting
        ? `Waiting out the refund lock · ~${blocks} blocks (${wait(blocks)})`
        : "Refund lock matured",
      state: waiting ? "running" : pendingCount > 0 || resolvedCount > 0 ? "passed" : "idle",
    },
    {
      label:
        resolvedCount > 0 && pendingCount === 0
          ? "Claimed back into your wallet"
          : claimableNow.length > 0 && !waiting
            ? "Broadcasting the claim transaction"
            : "Claiming back into your wallet",
      state: resolvedCount > 0 && pendingCount === 0 ? "passed" : waiting ? "idle" : "running",
    },
  ];

  return (
    <div className="h-full overflow-y-auto px-8 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <BackButton to="/swap" label="Back to Swap" />

        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 flex-none place-items-center rounded-card border border-success/40 bg-success/[0.08] text-success">
            <ShieldCheck size={20} strokeWidth={1.8} />
          </span>
          <div>
            <h1 className="font-header text-[26px] font-bold text-foreground">
              Your funds are safe
            </h1>
            <p className="mt-1 max-w-2xl text-[13.5px] leading-6 text-muted">
              This swap stopped after its funds were already committed, so they are sitting in
              Bitcoin contracts that <strong className="text-foreground">only you</strong> can
              spend. Portal is claiming them back. Nothing here needs you to act.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="flex flex-col gap-5 border-line-strong p-5">
            <div>
              <h2 className="font-header text-[14px] font-bold text-foreground">
                What happens next
              </h2>
              <p className="mt-1 text-[11.5px] leading-5 text-muted">
                Portal retries every minute. This page follows it on its own.
              </p>
            </div>
            <Checklist steps={steps} />
            {waiting && (
              <p className="border-t border-line pt-4 text-[11.5px] leading-5 text-subtle">
                The wait is a delay written into the contract you signed, not network congestion —
                it exists so the other side has time to act first, and paying a higher fee cannot
                shorten it. Your coins cannot move anywhere else in the meantime.
              </p>
            )}
          </Card>

          <div className="flex flex-col gap-4">
            <Card className="flex flex-col gap-3 border-line-strong p-4.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                  Held in contracts
                </span>
                <strong className="font-numeric text-[15px] text-foreground">
                  <SatsAmount sats={status?.lockedSats ?? 0} />
                </strong>
              </div>
              {waiting && (
                <div className="flex items-baseline justify-between gap-3 border-t border-line pt-3">
                  <span className="text-[12px] text-muted">Longest wait left</span>
                  <strong className="font-numeric text-[13px] text-warning">
                    ~{blocks} blocks
                  </strong>
                </div>
              )}
              <div className="flex items-center gap-2 border-t border-line pt-3 text-[11.5px] text-subtle">
                <Clock size={13} strokeWidth={2} className="flex-none" />
                Checked every minute
              </div>
              <Button size="sm" variant="secondary" onClick={() => void checkNow()} loading={checking}>
                Check now
              </Button>
            </Card>

            {/* Recovery only advances while the app is running, and the wait can be hours — so
                this is the one thing on the page the user can actually get wrong. */}
            <Notice tone="warning" icon={<AlertTriangle size={16} strokeWidth={2} />}>
              Leave Portal open. The claim transactions are built here, so quitting pauses recovery
              until the next launch — the funds stay safe either way.
            </Notice>

            <Card className="flex flex-col gap-2.5 border-line-strong p-4.5">
              <p className="text-[12px] leading-5 text-muted">
                Recovery holds nothing else up — send, receive and start another swap while it runs.
              </p>
              <Link
                to="/swap"
                className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:text-primary-hover"
              >
                Start another swap
                <ArrowRight size={13} strokeWidth={2} />
              </Link>
            </Card>
          </div>
        </div>

        <Card className="flex flex-col border-line-strong">
          <header className="flex items-baseline gap-3 border-b border-line px-4.5 py-3.5">
            <h2 className="font-header text-[14px] font-bold text-foreground">Contracts</h2>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
              {pendingCount} holding funds · {resolvedCount} claimed
            </span>
          </header>
          <div className="flex flex-col divide-y divide-line px-4.5">
            {(status?.pending ?? []).map((c) => (
              <ContractRow key={`${c.outpoint.txid}:${c.outpoint.vout}`} contract={c} />
            ))}
            {(status?.resolved ?? []).map((r) => (
              <div key={r.contractTxid} className="flex items-center justify-between gap-3 py-3">
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="truncate font-mono text-[12px] text-muted" title={r.contractTxid}>
                    {truncateMiddle(r.contractTxid, 10, 6)}
                  </span>
                  <StatusChip tone="success" className="self-start">
                    Claimed back
                  </StatusChip>
                </span>
                {r.spendingTxid && (
                  <span className="flex flex-none items-center gap-2">
                    <CopyButton text={r.spendingTxid} />
                    <ExternalLinkButton txid={r.spendingTxid} />
                  </span>
                )}
              </div>
            ))}
            {pendingCount === 0 && resolvedCount === 0 && (
              <p className="py-5 text-[12px] text-subtle">
                Reading the contracts off the chain…
              </p>
            )}
          </div>
        </Card>

        {tracker && (
          <Disclosure label="The route this swap was taking">
            <div className="flex justify-center pt-2">
              <SwapCircuit view={circuit} maxSize={460} />
            </div>
          </Disclosure>
        )}

        {status?.failureReason && (
          <Disclosure label="Why the swap stopped">
            <p className="pt-1 text-[12px] leading-5 text-muted">{status.failureReason}</p>
          </Disclosure>
        )}

        <Disclosure label="Logs" onOpenChange={setLogsOpen}>
          <div className="pt-2">
            <LogViewer lines={logs} className="max-h-64" newestFirst />
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
