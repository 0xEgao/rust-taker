import { Check, Copy, Inbox, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getMakerStatus, listMakers } from "../../api/commands";
import type { MakerPhase, MakerSettings, MakerStatus } from "../../api/types";
import { SatsAmount } from "../../components/ui/display";
import { formatTorEndpoint } from "../../lib/market-format";
import { useHeaderActionsStore } from "../../store/header-actions";
import { useToastStore } from "../../store/toast";

interface OwnedMaker {
  settings: MakerSettings;
  status: MakerStatus | null;
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

function ConfigValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <span className="font-mono text-[9.5px] uppercase tracking-widest text-subtle">{label}</span>
      <strong className="mt-1.5 block truncate font-mono text-[12px] font-semibold text-foreground">
        {children}
      </strong>
    </div>
  );
}

function MakerCard({ maker }: { maker: OwnedMaker }) {
  const [copied, setCopied] = useState(false);
  const { settings, status } = maker;
  const phase = status?.phase.phase ?? "notConfigured";
  const torAddress = status?.torAddress;

  function copyTorAddress() {
    if (!torAddress) return;
    void navigator.clipboard.writeText(torAddress).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  return (
    <article className="flex min-h-[330px] flex-col rounded-lg border border-line-strong bg-surface-raised/55 p-5 transition-colors hover:border-primary/35">
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PHASE_CLASS[phase]}`} />
        <h3 className="min-w-0 truncate text-[18px] font-bold text-foreground" title={settings.makerId}>
          {settings.makerId}
        </h3>
      </div>

      <div className="mt-5 flex h-[70px] items-center gap-3 rounded-lg border border-line bg-surface/70 px-4">
        <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-widest text-subtle">Tor</span>
        <code className="min-w-0 flex-1 truncate text-[11.5px] text-muted" title={torAddress}>
          {torAddress ? formatTorEndpoint(torAddress, 16, 10, true) : "Address unavailable"}
        </code>
        <button
          type="button"
          onClick={copyTorAddress}
          disabled={!torAddress}
          aria-label={`Copy ${settings.makerId} Tor address`}
          title="Copy Tor address"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-white/[0.05] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        >
          {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-surface/45 [&>*:nth-child(odd)]:border-r [&>*:nth-child(-n+2)]:border-b [&>*]:border-line">
        <ConfigValue label="Minimum swap"><SatsAmount sats={settings.minSwapAmount} /></ConfigValue>
        <ConfigValue label="Fidelity target"><SatsAmount sats={settings.fidelityAmount} /></ConfigValue>
        <ConfigValue label="Base fee"><SatsAmount sats={settings.baseFee} /></ConfigValue>
        <ConfigValue label="Network / RPC">{settings.networkPort} / {settings.rpcPort}</ConfigValue>
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 pt-5">
        <div className="min-w-0">
          <span className="font-mono text-[9.5px] uppercase tracking-widest text-subtle">
            Status · {phaseLabel(phase)}
          </span>
          <span className="mt-1 block truncate font-mono text-[10px] text-muted" title={settings.walletName}>
            Wallet · {settings.walletName}
          </span>
        </div>
        {status?.phase.phase === "failed" && (
          <span className="max-w-[48%] truncate text-right text-[10px] text-danger" title={status.phase.message}>
            {status.phase.message}
          </span>
        )}
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
    const statuses = await Promise.allSettled(
      registrations.map((maker) => getMakerStatus(maker.makerId)),
    );
    setMakers(registrations.map((settings, index) => ({
      settings,
      status: statuses[index].status === "fulfilled" ? statuses[index].value : null,
    })));
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } catch (error) {
      pushToast("error", (error as { message?: string })?.message ?? "Failed to load your makers.");
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [load, pushToast]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    useHeaderActionsStore.getState().register(() => void refresh());
    return () => {
      useHeaderActionsStore.getState().register(null);
      useHeaderActionsStore.getState().setRefreshing(false);
    };
  }, [refresh]);

  useEffect(() => {
    useHeaderActionsStore.getState().setRefreshing(refreshing);
  }, [refreshing]);

  const stats = useMemo(() => {
    const running = makers.filter((maker) => maker.status?.running).length;
    return {
      running,
      stopped: makers.length - running,
      configuredLiquidity: makers.reduce((sum, maker) => sum + maker.settings.minSwapAmount, 0),
    };
  }, [makers]);

  const visibleMakers = useMemo(() => makers.filter((maker) => {
    if (filter === "running") return maker.status?.running;
    if (filter === "stopped") return !maker.status?.running;
    return true;
  }), [filter, makers]);

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[1500px]">
        <header className="grid grid-cols-[minmax(260px,0.9fr)_minmax(520px,1.45fr)] items-stretch gap-5">
          <div className="flex flex-col justify-center py-2">
            <div className="mb-4 inline-flex w-fit items-center gap-2 rounded-full border border-primary/35 bg-primary/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              Signet
            </div>
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-lg bg-primary text-white">
                <Server size={23} strokeWidth={2.2} />
              </span>
              <h1 className="text-[30px] font-bold leading-none text-foreground">Coinswap Maker</h1>
            </div>
            <p className="mt-3 text-[13px] text-muted">Operate your maker instances and provide Coinswap liquidity.</p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Metric label="Registered" value={makers.length.toLocaleString()} detail="maker instances" />
            <Metric label="Running" value={stats.running.toLocaleString()} detail={`${stats.stopped} currently stopped`} tone="success" />
            <Metric label="Configured minimum" value={<SatsAmount sats={stats.configuredLiquidity} />} detail="across all makers" />
          </div>
        </header>

        <section className="mt-8">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <h2 className="text-[22px] font-bold text-foreground">Makers</h2>
              <div className="flex h-10 items-center rounded-full border border-line-strong bg-surface-raised p-1" role="tablist" aria-label="Filter makers">
                {([
                  ["all", "All", makers.length],
                  ["running", "Running", stats.running],
                  ["stopped", "Stopped", stats.stopped],
                ] as const).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={filter === id}
                    onClick={() => setFilter(id)}
                    className={`h-8 rounded-full px-3.5 text-[11px] font-semibold transition-colors ${filter === id ? "bg-primary text-white" : "text-muted hover:text-foreground"}`}
                  >
                    {label} <span className="ml-1 font-mono text-[10px] opacity-75">{count}</span>
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label="Refresh makers"
              title="Refresh makers"
              className="grid h-10 w-10 place-items-center rounded-full border border-line-strong bg-surface-raised text-muted transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-60"
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
            </button>
          </div>

          {loading ? (
            <div className="grid min-h-[320px] place-items-center text-center text-[13px] text-subtle">
              <div><RefreshCw size={38} className="mx-auto animate-spin text-primary" /><strong className="mt-3 block text-[15px] text-foreground">Loading your makers...</strong></div>
            </div>
          ) : visibleMakers.length === 0 ? (
            <div className="mt-5 grid min-h-[280px] place-items-center rounded-lg border border-line-strong bg-surface-raised/45 text-center text-[13px] text-subtle">
              <div><Inbox size={38} className="mx-auto text-primary" /><strong className="mt-3 block text-[15px] text-foreground">No makers in this view</strong><span className="mt-1 block">Choose another status filter.</span></div>
            </div>
          ) : (
            <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {visibleMakers.map((maker) => <MakerCard key={maker.settings.makerId} maker={maker} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
