import { ArrowRight, Check, Copy, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { getMakerBalances, getMakerLogs, getMakerStatus, startMaker } from "../../api/commands";
import type { LogLine, MakerPhase } from "../../api/types";
import { Card, LogViewer, SatsAmount } from "../../components/ui/display";
import { Checklist, type CheckState } from "../../components/ui/Checklist";
import { Button, LinkButton } from "../../components/ui/inputs";
import { IntroStage } from "../../components/ui/IntroStage";

/**
 * A maker cannot be bonded before it runs: the server derives the fidelity-bond address itself
 * on startup and announces it in its log, then waits for the deposit. So setup is start → read
 * the address out of the log → fund it → the server bonds and goes live on its own.
 */
type Stage = "starting" | "funding" | "bonding" | "live" | "error";

const LOG_POLL_MS = 1500;
const BALANCE_POLL_MS = 8000;

// The crate only surfaces the bond address and its minimum in this one log line.
const DEPOSIT_RE = /Send at least ([\d.]+) BTC to (\S+)/;

function readDeposit(lines: LogLine[]): { address: string; sats: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].line.match(DEPOSIT_RE);
    if (match) return { address: match[2], sats: Math.round(Number(match[1]) * 1e8) };
  }
  return null;
}

/** Spending starts the moment coins land, well before the bond exists. */
const FUNDED_MARKERS = [
  "Transaction seen in mempool",
  "Coinselection",
  "Successfully created fidelity bond",
];

function looksFunded(lines: LogLine[]) {
  return lines.some((l) => FUNDED_MARKERS.some((marker) => l.line.includes(marker)));
}

const STEP_LABELS = ["Starting maker", "Awaiting deposit", "Creating fidelity bond", "Live on the network"];
const ORDER: Stage[] = ["starting", "funding", "bonding", "live"];

function stepStates(stage: Stage, failedAt: number): CheckState[] {
  const index = ORDER.indexOf(stage);
  return STEP_LABELS.map((_, i) => {
    if (stage === "error") return i === failedAt ? "failed" : i < failedAt ? "passed" : "idle";
    if (i < index) return "passed";
    if (i === index) return stage === "live" ? "passed" : "running";
    return "idle";
  });
}

export function MakerSetupPage() {
  const { makerId } = useParams<{ makerId: string }>();
  const id = makerId!;
  const navigate = useNavigate();

  const [stage, setStage] = useState<Stage>("starting");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [deposit, setDeposit] = useState<{ address: string; sats: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Which step to mark failed — the stage at the time, since `stage` becomes "error".
  const failedAt = useRef(0);

  const fail = useCallback((message: string) => {
    setError(message);
    setStage((current) => {
      failedAt.current = Math.max(0, ORDER.indexOf(current));
      return "error";
    });
  }, []);

  // Phase is authoritative for "live": the backend flips to Running only once the server
  // reports setup complete, which is bond confirmed and liquidity ready.
  const applyPhase = useCallback(
    (phase: MakerPhase) => {
      if (phase.phase === "running") setStage("live");
      else if (phase.phase === "failed") fail(phase.message);
    },
    [fail],
  );

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<{ makerId: string; phase: MakerPhase }>("maker://phase-changed", (event) => {
      if (event.payload.makerId === id) applyPhase(event.payload.phase);
    });

    void (async () => {
      try {
        const status = await getMakerStatus(id);
        if (cancelled) return;
        // Resuming an interrupted setup, or arriving at an already-running maker.
        if (status.running) return applyPhase(status.phase);
        await startMaker(id);
      } catch (e) {
        if (!cancelled) fail((e as { message?: string })?.message ?? "Could not start the maker.");
      }
    })();

    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, [id, applyPhase, fail]);

  // One poll drives both the log panel and stage detection: the deposit address exists only
  // in the log, and coins landing shows up there before any balance read reflects it.
  useEffect(() => {
    if (stage === "live" || stage === "error") return;
    const tick = async () => {
      const lines = await getMakerLogs(id, 300).catch(() => null);
      if (!lines) return;
      setLogs(lines);
      const found = readDeposit(lines);
      if (found) setDeposit(found);
      setStage((current) => {
        if (current !== "starting" && current !== "funding") return current;
        if (looksFunded(lines)) return "bonding";
        return found ? "funding" : current;
      });
    };
    void tick();
    const timer = setInterval(() => void tick(), LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [id, stage]);

  // Fallback for a deposit whose log markers never appear — a balance is proof enough.
  useEffect(() => {
    if (stage !== "funding") return;
    const timer = setInterval(() => {
      void getMakerBalances(id)
        .then((b) => {
          if (b.regular > 0 || b.spendable > 0) setStage("bonding");
        })
        .catch(() => {});
    }, BALANCE_POLL_MS);
    return () => clearInterval(timer);
  }, [id, stage]);

  function copyAddress() {
    if (!deposit) return;
    void navigator.clipboard.writeText(deposit.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  const caption =
    stage === "error"
      ? "Setup could not finish"
      : stage === "live"
        ? `${id} is live`
        : stage === "funding"
          ? "Fund the fidelity bond"
          : stage === "bonding"
            ? "Creating the fidelity bond"
            : `Starting ${id}`;

  return (
    <IntroStage lead="OpenSwap" accent="Maker" caption={caption} className="min-h-full">
      <div className="mx-auto w-full max-w-lg">
        <Card glow={stage === "funding"} className="border-line-strong">
          <div className="p-8 text-left">
            <Checklist steps={STEP_LABELS.map((label, i) => ({ label, state: stepStates(stage, failedAt.current)[i] }))} />
          </div>

          {stage === "funding" && (
            <div className="border-t border-line px-8 py-6 text-left">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Deposit address</span>
                {deposit && (
                  <span className="text-[12px] text-muted">
                    Send at least <SatsAmount sats={deposit.sats} className="font-numeric text-foreground" />
                  </span>
                )}
              </div>
              {deposit ? (
                <button
                  type="button"
                  onClick={copyAddress}
                  className="lift mt-3 flex w-full items-start gap-3 rounded-control border border-primary/35 bg-primary/[0.07] px-4 py-3.5 text-left outline-none hover:border-primary/60 focus-visible:shadow-ring"
                >
                  <span className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-primary">
                    {deposit.address}
                  </span>
                  {copied ? (
                    <Check size={15} className="mt-0.5 flex-none text-success" />
                  ) : (
                    <Copy size={15} className="mt-0.5 flex-none text-subtle" />
                  )}
                </button>
              ) : (
                <p className="mt-3 text-[12.5px] text-muted">
                  Waiting for the maker to report its bond address…
                </p>
              )}
              <p className="mt-3 text-[11.5px] text-subtle">
                The maker watches this address and bonds the funds itself. Leave this open — it
                keeps running if you navigate away.
              </p>
              <p className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-5 text-warning">
                <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
                Fidelity funds are time-locked. Once bonded they cannot be spent until the timelock
                expires.
              </p>
            </div>
          )}

          {stage === "live" && (
            <div className="flex items-center justify-between gap-4 border-t border-line px-8 py-5">
              <p className="text-[12.5px] text-muted">Serving swaps on the OpenSwap network.</p>
              <Button onClick={() => navigate(`/maker/${encodeURIComponent(id)}`)}>
                Open maker
                <ArrowRight size={15} strokeWidth={2} />
              </Button>
            </div>
          )}

          {stage === "error" && (
            <div className="border-t border-line px-8 py-5 text-left">
              <p className="text-[12.5px] text-danger">{error}</p>
              <div className="mt-4 flex gap-3">
                <LinkButton to="/maker" variant="secondary">Back to makers</LinkButton>
                <Button className="flex-1" onClick={() => navigate(`/maker/${encodeURIComponent(id)}`)}>
                  Open maker anyway
                </Button>
              </div>
            </div>
          )}
        </Card>

        <div className="mt-4 text-left">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Maker log</span>
          <div className="mt-2 h-56 overflow-hidden rounded-card border border-line">
            <LogViewer lines={logs} emptyMessage="Waiting for the maker to start…" className="h-full" />
          </div>
        </div>
      </div>
    </IntroStage>
  );
}
