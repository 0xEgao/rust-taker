import { Check, Copy, Inbox, Plus, RefreshCw, Server, Square, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getMakerBalances,
  getMakerStatus,
  listMakerSwapReports,
  listMakers,
  startMaker,
  stopMaker,
} from "../../api/commands";
import type { Balances, MakerPhase, MakerSettings, MakerStatus } from "../../api/types";
import { SatsAmount } from "../../components/ui/display";
import { Button } from "../../components/ui/inputs";
import { formatTorEndpoint } from "../../lib/market-format";
import { MakerOnboardingIntro } from "./MakerOnboardingIntro";
import { useHeaderActionsStore } from "../../store/header-actions";
import { useToastStore } from "../../store/toast";

interface OwnedMaker {
  settings: MakerSettings;
  status: MakerStatus | null;
  balances: Balances | null;
  earningsSats: number | null;
  reportCount: number | null;
}

type MakerFilter = "all" | "running" | "stopped";

const PHASE_CLASS: Record<MakerPhase["phase"], string> = {
  notConfigured: "bg-subtle",
  initializing: "bg-warning shadow-[0_0_10px_rgba(245,196,81,0.45)]",
  starting: "bg-warning shadow-[0_0_10px_rgba(245,196,81,0.45)]",
  running: "bg-success shadow-[0_0_10px_rgba(49,209,88,0.5)]",
  stopping: "bg-warning shadow-[0_0_10px_rgba(245,196,81,0.45)]",
  stopped: "bg-subtle",
  failed: "bg-danger shadow-[0_0_10px_rgba(255,90,95,0.45)]",
};

function phaseLabel(phase: MakerPhase["phase"]): string {
  return phase.replace(/([A-Z])/g, " $1").toLowerCase();
}

function Metric({ label, value, detail, tone = "primary" }: {
  label: string;
  value: React.ReactNode;
  detail: string;
  tone?: "primary" | "success";
}) {
  return (
    <div className="relative min-h-[112px] overflow-hidden rounded-lg border border-line-strong bg-surface-raised/70 px-5 py-4">
      <span className={`absolute inset-y-0 left-0 w-1 ${tone === "success" ? "bg-success" : "bg-primary"}`} />
      <span className="font-mono text-[10.5px] uppercase tracking-widest text-subtle">{label}</span>
      <strong className={`mt-2 block text-[25px] font-bold ${tone === "success" ? "text-success" : "text-primary"}`}>
        {value}
      </strong>
      <span className="mt-1 block text-[12px] text-muted">{detail}</span>
    </div>
  );
}

function BalanceValue({ label, sats, tone }: { label: string; sats: number; tone?: string }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <span className="font-mono text-[9.5px] uppercase tracking-widest text-subtle">{label}</span>
      <strong className={`mt-1.5 block truncate font-mono text-[12px] font-semibold ${tone ?? "text-foreground"}`}>
        <SatsAmount sats={sats} />
      </strong>
    </div>
  );
}

function MakerCard({ maker, onChanged }: { maker: OwnedMaker; onChanged: () => Promise<void> }) {
  const pushToast = useToastStore((state) => state.push);
  const [copied, setCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const { settings, status, balances } = maker;
  const phase = status?.phase.phase ?? "notConfigured";
  const running = phase === "running" || phase === "starting";
  const transitioning = ["initializing", "starting", "stopping"].includes(phase);
  const torAddress = status?.torAddress;

  function copyTorAddress() {
    if (!torAddress) return;
    void navigator.clipboard.writeText(torAddress).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  async function toggleMaker() {
    setActionLoading(true);
    try {
      if (running) await stopMaker(settings.makerId);
      else await startMaker(settings.makerId);
      pushToast("success", `${settings.makerId} ${running ? "stopped" : "is starting"}.`);
      await onChanged();
    } catch (error) {
      pushToast("error", (error as { message?: string })?.message ?? `Could not ${running ? "stop" : "start"} maker.`);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <article className="flex min-h-[350px] flex-col rounded-lg border border-line-strong bg-surface-raised/55 p-5 transition-colors hover:border-primary/35">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PHASE_CLASS[phase]}`} />
          <h3 className="min-w-0 truncate text-[18px] font-bold text-foreground" title={settings.makerId}>{settings.makerId}</h3>
        </div>
        <span className="rounded-pill border border-line px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-muted">
          {phaseLabel(phase)}
        </span>
      </div>

      <div className="mt-5 flex h-[62px] items-center gap-3 rounded-lg border border-line bg-surface/70 px-4">
        <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-widest text-subtle">Tor</span>
        <code className="min-w-0 flex-1 truncate text-[11.5px] text-muted" title={torAddress}>
          {torAddress ? formatTorEndpoint(torAddress, 16, 10, true) : running ? "Waiting for address…" : "Available after start"}
        </code>
        <button type="button" onClick={copyTorAddress} disabled={!torAddress} aria-label="Copy Tor address" className="grid h-8 w-8 shrink-0 place-items-center rounded-control text-muted hover:bg-white/[0.05] hover:text-foreground disabled:opacity-30">
          {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
        </button>
      </div>

      {balances ? (
        <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-line [&>*:nth-child(odd)]:mr-px [&>*:nth-child(-n+2)]:mb-px [&>*]:bg-surface/80">
          <BalanceValue label="Spendable" sats={balances.spendable} tone="text-primary" />
          <BalanceValue label="Regular" sats={balances.regular} />
          <BalanceValue label="Swap" sats={balances.swap} tone="text-success" />
          <BalanceValue label="Fidelity" sats={balances.fidelity} tone="text-warning" />
        </div>
      ) : (
        <div className="mt-4 grid min-h-[114px] place-items-center rounded-lg border border-dashed border-line px-5 text-center">
          <div>
            <strong className="text-[12px] text-foreground">{running ? "Wallet data is loading" : "Maker wallet is not loaded"}</strong>
            <span className="mt-1 block text-[11px] text-subtle">{running ? "Refresh shortly to see live balances." : "Start this maker to load live balance data."}</span>
          </div>
        </div>
      )}

      <div className="mt-auto flex items-end justify-between gap-3 pt-5">
        <div className="min-w-0">
          <span className="font-mono text-[9.5px] uppercase tracking-widest text-subtle">
            {maker.reportCount === null ? "Reports unavailable" : `${maker.reportCount} reports · ${Math.round(maker.earningsSats ?? 0).toLocaleString()} sats earned`}
          </span>
          {phase === "failed" && <span className="mt-1 block max-w-[240px] truncate text-[10px] text-danger" title={status?.phase.phase === "failed" ? status.phase.message : undefined}>{status?.phase.phase === "failed" ? status.phase.message : ""}</span>}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" onClick={() => void toggleMaker()} loading={actionLoading} disabled={transitioning}>
            {running ? <Square size={12} /> : <Play size={12} />}{running ? "Stop" : "Start"}
          </Button>
          <Link to={`/maker/${encodeURIComponent(settings.makerId)}`} className="inline-flex h-8 items-center justify-center rounded-control bg-primary px-4 text-[12px] font-semibold text-white hover:bg-primary-hover">Manage</Link>
        </div>
      </div>
    </article>
  );
}

export function MakerPage() {
  const [makers, setMakers] = useState<OwnedMaker[]>([]);
  const [filter, setFilter] = useState<MakerFilter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pushToast = useToastStore((state) => state.push);

  const load = useCallback(async () => {
    const registrations = await listMakers();
    const rows = await Promise.all(registrations.map(async (settings): Promise<OwnedMaker> => {
      const [status, balances, reports] = await Promise.allSettled([
        getMakerStatus(settings.makerId),
        getMakerBalances(settings.makerId),
        listMakerSwapReports(settings.makerId),
      ]);
      const reportRows = reports.status === "fulfilled" ? reports.value : null;
      return {
        settings,
        status: status.status === "fulfilled" ? status.value : null,
        balances: balances.status === "fulfilled" ? balances.value : null,
        earningsSats: reportRows?.reduce((sum, report) => sum + report.feeEarnedSats, 0) ?? null,
        reportCount: reportRows?.length ?? null,
      };
    }));
    setMakers(rows);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); }
    catch (error) { pushToast("error", (error as { message?: string })?.message ?? "Failed to load your makers."); }
    finally { setRefreshing(false); setLoading(false); }
  }, [load, pushToast]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    useHeaderActionsStore.getState().register(() => void refresh());
    return () => { useHeaderActionsStore.getState().register(null); useHeaderActionsStore.getState().setRefreshing(false); };
  }, [refresh]);
  useEffect(() => { useHeaderActionsStore.getState().setRefreshing(refreshing); }, [refreshing]);

  const stats = useMemo(() => {
    const running = makers.filter((maker) => maker.status?.phase.phase === "running").length;
    return {
      running,
      stopped: makers.length - running,
      spendable: makers.reduce((sum, maker) => sum + (maker.balances?.spendable ?? 0), 0),
      earnings: makers.reduce((sum, maker) => sum + (maker.earningsSats ?? 0), 0),
    };
  }, [makers]);
  const visibleMakers = useMemo(() => makers.filter((maker) => filter === "all" || (filter === "running" ? maker.status?.phase.phase === "running" : maker.status?.phase.phase !== "running")), [filter, makers]);

  // Zero makers is a "nothing exists yet" state, not a dashboard reporting zeros — the metric
  // row and status filters below would read as a broken install on a first run.
  if (!loading && makers.length === 0) {
    return (
      <div className="h-full overflow-y-auto p-8">
        <MakerOnboardingIntro />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[1500px]">
        <header className="grid grid-cols-[minmax(260px,0.9fr)_minmax(520px,1.45fr)] items-stretch gap-5 max-[1050px]:grid-cols-1">
          <div className="flex flex-col justify-center py-2">
            <div className="mb-4 inline-flex w-fit items-center gap-2 rounded-full border border-primary/35 bg-primary/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary" />Signet</div>
            <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-lg bg-primary text-white"><Server size={23} /></span><h1 className="text-[30px] font-bold leading-none text-foreground">Coinswap Maker</h1></div>
            <p className="mt-3 text-[13px] text-muted">Operate maker instances and provide Coinswap liquidity.</p>
          </div>
          <div className="grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
            <Metric label="Spendable" value={<SatsAmount sats={stats.spendable} />} detail={`across ${makers.length} makers`} />
            <Metric label="Running" value={stats.running.toLocaleString()} detail={`${stats.stopped} currently stopped`} tone="success" />
            <Metric label="Net earnings" value={<SatsAmount sats={stats.earnings} />} detail="from saved maker reports" tone="success" />
          </div>
        </header>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <h2 className="text-[22px] font-bold text-foreground">Makers</h2>
              <div className="flex h-10 items-center rounded-full border border-line-strong bg-surface-raised p-1" role="tablist">
                {([ ["all", "All", makers.length], ["running", "Running", stats.running], ["stopped", "Stopped", stats.stopped] ] as const).map(([id, label, count]) => (
                  <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} className={`h-8 rounded-full px-3.5 text-[11px] font-semibold ${filter === id ? "bg-primary text-white" : "text-muted hover:text-foreground"}`}>{label} <span className="ml-1 font-mono text-[10px] opacity-75">{count}</span></button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh makers" className="grid h-10 w-10 place-items-center rounded-full border border-line-strong bg-surface-raised text-muted hover:text-primary disabled:opacity-60"><RefreshCw size={16} className={refreshing ? "animate-spin" : ""} /></button>
              <Link to="/maker/new" className="inline-flex h-10 items-center gap-2 rounded-control bg-primary px-5 text-[13px] font-semibold text-white hover:bg-primary-hover"><Plus size={15} />Add maker</Link>
            </div>
          </div>

          {loading ? (
            <div className="grid min-h-[320px] place-items-center text-center text-[13px] text-subtle"><div><RefreshCw size={38} className="mx-auto animate-spin text-primary" /><strong className="mt-3 block text-[15px] text-foreground">Loading your makers…</strong></div></div>
          ) : visibleMakers.length === 0 ? (
            <div className="mt-5 grid min-h-[280px] place-items-center rounded-lg border border-line-strong bg-surface-raised/45 text-center text-[13px] text-subtle">
              <div><Inbox size={38} className="mx-auto text-primary" /><strong className="mt-3 block text-[15px] text-foreground">{makers.length === 0 ? "Create your first maker" : "No makers in this view"}</strong><span className="mt-1 block">{makers.length === 0 ? "Configure a maker wallet, Tor ports, and fee policy." : "Choose another status filter."}</span>{makers.length === 0 && <Link to="/maker/new" className="mt-5 inline-flex h-10 items-center gap-2 rounded-control bg-primary px-5 font-semibold text-white"><Plus size={15} />Create maker</Link>}</div>
            </div>
          ) : (
            <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">{visibleMakers.map((maker) => <MakerCard key={maker.settings.makerId} maker={maker} onChanged={refresh} />)}</div>
          )}
        </section>
      </div>
    </div>
  );
}
