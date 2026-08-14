import {
  Check,
  Copy,
  Inbox,
  Plus,
  RefreshCw,
  Square,
  Play,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  getMakerBalances,
  getMakerStatus,
  listMakerSwapReports,
  listMakers,
  startMaker,
  stopMaker,
} from "../../api/commands";
import type {
  Balances,
  MakerPhase,
  MakerSettings,
  MakerStatus,
} from "../../api/types";
import {
  EmptyState,
  EntityMonogram,
  SatsAmount,
  StatStrip,
  StatusChip,
} from "../../components/ui/display";
import {
  Button,
  LinkButton,
  SegmentedToggle,
} from "../../components/ui/inputs";
import { formatTorEndpoint } from "../../lib/market-format";
import { MakerIntro } from "./MakerIntro";
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
  initializing:
    "bg-warning shadow-[0_0_10px_color-mix(in_oklab,var(--color-warning)_45%,transparent)]",
  starting:
    "bg-warning shadow-[0_0_10px_color-mix(in_oklab,var(--color-warning)_45%,transparent)]",
  running:
    "bg-success shadow-[0_0_10px_color-mix(in_oklab,var(--color-success)_50%,transparent)]",
  stopping:
    "bg-warning shadow-[0_0_10px_color-mix(in_oklab,var(--color-warning)_45%,transparent)]",
  stopped: "bg-subtle",
  failed:
    "bg-danger shadow-[0_0_10px_color-mix(in_oklab,var(--color-danger)_45%,transparent)]",
};

function phaseLabel(phase: MakerPhase["phase"]): string {
  return phase.replace(/([A-Z])/g, " $1").toLowerCase();
}

function phaseTone(
  phase: MakerPhase["phase"],
): "success" | "warning" | "danger" | "subtle" {
  if (phase === "running") return "success";
  if (phase === "failed") return "danger";
  if (["initializing", "starting", "stopping"].includes(phase))
    return "warning";
  return "subtle";
}

function BalanceValue({ label, sats, tone }: { label: string; sats: number; tone?: string }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">{label}</span>
      <strong className={`mt-1.5 block truncate font-mono text-[12px] font-semibold ${tone ?? "text-foreground"}`}>
        <SatsAmount sats={sats} />
      </strong>
    </div>
  );
}

function MakerCard({
  maker,
  onChanged,
}: {
  maker: OwnedMaker;
  onChanged: () => Promise<void>;
}) {
  const pushToast = useToastStore((state) => state.push);
  const [copied, setCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const { settings, status, balances } = maker;
  const phase = status?.phase.phase ?? "notConfigured";
  const running = phase === "running" || phase === "starting";
  const transitioning = ["initializing", "starting", "stopping"].includes(
    phase,
  );
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
      pushToast(
        "success",
        `${settings.makerId} ${running ? "stopped" : "is starting"}.`,
      );
      await onChanged();
    } catch (error) {
      pushToast(
        "error",
        (error as { message?: string })?.message ??
          `Could not ${running ? "stop" : "start"} maker.`,
      );
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <article className={`lift flex flex-col rounded-card border border-line-strong bg-surface-raised/55 p-5 hover:border-primary/35 ${balances || running ? "min-h-[350px]" : "min-h-[250px]"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <EntityMonogram name={settings.makerId} size="sm" />
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PHASE_CLASS[phase]}`} />
          <h3 className="min-w-0 truncate text-[18px] font-bold text-foreground" title={settings.makerId}>{settings.makerId}</h3>
        </div>
        <StatusChip tone={phaseTone(phase)}>{phaseLabel(phase)}</StatusChip>
      </div>

      <div className="mt-5 flex h-[62px] items-center gap-3 rounded-card border border-line bg-surface/70 px-4">
        <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Tor</span>
        <code
          className="min-w-0 flex-1 truncate text-[11.5px] text-muted"
          title={torAddress}
        >
          {torAddress
            ? formatTorEndpoint(torAddress, 16, 10, true)
            : running
              ? "Waiting for address…"
              : "Available after start"}
        </code>
        <button
          type="button"
          onClick={copyTorAddress}
          disabled={!torAddress}
          aria-label="Copy Tor address"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-control text-muted outline-none hover:bg-[var(--color-hover)] hover:text-foreground focus-visible:shadow-ring active:translate-y-px disabled:opacity-30"
        >
          {copied ? (
            <Check size={15} className="text-success" />
          ) : (
            <Copy size={15} />
          )}
        </button>
      </div>

      {balances ? (
        <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-card border border-line bg-line [&>*:nth-child(odd)]:mr-px [&>*:nth-child(-n+2)]:mb-px [&>*]:bg-surface/80">
          <BalanceValue label="Spendable" sats={balances.spendable} tone="text-primary" />
          <BalanceValue label="Regular" sats={balances.regular} />
          <BalanceValue label="Swap" sats={balances.swap} tone="text-success" />
          <BalanceValue label="Fidelity" sats={balances.fidelity} tone="text-warning" />
        </div>
      ) : running ? (
        <div className="mt-4 grid min-h-[114px] place-items-center rounded-card border border-dashed border-line px-5 text-center">
          <div>
            <strong className="text-[12px] text-foreground">Wallet data is loading</strong>
            <span className="mt-1 block text-[11px] text-subtle">Refresh shortly to see live balances.</span>
          </div>
        </div>
      ) : null}

      <div className="mt-auto flex items-end justify-between gap-3 pt-5">
        <div className="min-w-0">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
            {maker.reportCount === null ? (
              "Reports unavailable"
            ) : (
              <>
                {maker.reportCount} reports ·{" "}
                <SatsAmount sats={maker.earningsSats ?? 0} /> earned
              </>
            )}
          </span>
          {phase === "failed" && (
            <span className="mt-1 block max-w-[240px] truncate text-[10px] text-danger" title={status?.phase.phase === "failed" ? status.phase.message : undefined}>
              {status?.phase.phase === "failed" ? status.phase.message : ""}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void toggleMaker()}
            loading={actionLoading}
            disabled={transitioning}
          >
            {running ? <Square size={12} /> : <Play size={12} />}
            {running ? "Stop" : "Start"}
          </Button>
          <LinkButton
            to={`/maker/${encodeURIComponent(settings.makerId)}`}
            size="sm"
          >
            Manage
          </LinkButton>
        </div>
      </div>
    </article>
  );
}

export function MakerPage() {
  const [makers, setMakers] = useState<OwnedMaker[]>([]);
  const [filter, setFilter] = useState<MakerFilter>("all");
  const [loading, setLoading] = useState(true);
  const pushToast = useToastStore((state) => state.push);

  const load = useCallback(async () => {
    const registrations = await listMakers();
    const rows = await Promise.all(
      registrations.map(async (settings): Promise<OwnedMaker> => {
        const [status, balances, reports] = await Promise.allSettled([
          getMakerStatus(settings.makerId),
          getMakerBalances(settings.makerId),
          listMakerSwapReports(settings.makerId),
        ]);
        const reportRows =
          reports.status === "fulfilled" ? reports.value : null;
        return {
          settings,
          status: status.status === "fulfilled" ? status.value : null,
          balances: balances.status === "fulfilled" ? balances.value : null,
          earningsSats:
            reportRows?.reduce(
              (sum, report) => sum + report.feeEarnedSats,
              0,
            ) ?? null,
          reportCount: reportRows?.length ?? null,
        };
      }),
    );
    setMakers(rows);
  }, []);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (error) {
      pushToast(
        "error",
        (error as { message?: string })?.message ??
          "Failed to load your makers.",
      );
    } finally {
      setLoading(false);
    }
  }, [load, pushToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stats = useMemo(() => {
    const running = makers.filter(
      (maker) => maker.status?.phase.phase === "running",
    ).length;
    return {
      running,
      stopped: makers.length - running,
      spendable: makers.reduce(
        (sum, maker) => sum + (maker.balances?.spendable ?? 0),
        0,
      ),
      earnings: makers.reduce(
        (sum, maker) => sum + (maker.earningsSats ?? 0),
        0,
      ),
    };
  }, [makers]);
  const visibleMakers = useMemo(
    () =>
      makers.filter(
        (maker) =>
          filter === "all" ||
          (filter === "running"
            ? maker.status?.phase.phase === "running"
            : maker.status?.phase.phase !== "running"),
      ),
    [filter, makers],
  );

  // No page padding: the intro sets its own, and its backdrop has to reach the page edges.
  if (!loading && makers.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <MakerIntro />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[1500px]">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="mb-3 flex items-center gap-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.18em] text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_70%,transparent)]" />
              Maker Console · Signet
            </div>
            <h1 className="text-[28px] font-bold leading-none text-foreground">Maker fleet</h1>
            <p className="mt-2 text-[12.5px] text-muted">Operate liquidity services, wallets, and earnings from one workspace.</p>
          </div>
          <div className="flex gap-2">
            <LinkButton to="/maker/new"><Plus size={15} /> Add maker</LinkButton>
          </div>
        </header>

        <StatStrip
          className="mt-6"
          items={[
            { label: "Makers", value: makers.length.toLocaleString(), detail: `${stats.running} running` },
            { label: "Running", value: stats.running.toLocaleString(), detail: `${stats.stopped} stopped`, tone: "success" },
            { label: "Spendable", value: <SatsAmount sats={stats.spendable} />, detail: "across maker wallets" },
            { label: "Net earnings", value: <SatsAmount sats={stats.earnings} />, detail: "from saved reports", tone: "success" },
          ]}
        />

        <section className="mt-7">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <h2 className="text-[20px] font-bold text-foreground">Makers</h2>
              <SegmentedToggle
                groupId="maker-filter"
                value={filter}
                onChange={setFilter}
                options={[
                  {
                    value: "all",
                    label: "All",
                    suffix: <span>{makers.length}</span>,
                  },
                  {
                    value: "running",
                    label: "Running",
                    suffix: <span>{stats.running}</span>,
                  },
                  {
                    value: "stopped",
                    label: "Stopped",
                    suffix: <span>{stats.stopped}</span>,
                  },
                ]}
              />
            </div>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-subtle">{visibleMakers.length} shown</span>
          </div>

          {loading ? (
            <div className="grid min-h-[320px] place-items-center text-center text-[13px] text-subtle">
              <div>
                <RefreshCw
                  size={38}
                  className="mx-auto animate-spin text-primary"
                />
                <strong className="mt-3 block text-[15px] text-foreground">
                  Loading your makers…
                </strong>
              </div>
            </div>
          ) : visibleMakers.length === 0 ? (
            <div className="mt-5 rounded-card border border-line-strong bg-surface-raised/45">
              <EmptyState
                size="lg"
                icon={<Inbox size={38} />}
                title={
                  makers.length === 0
                    ? "Create your first maker"
                    : "No makers in this view"
                }
                description={
                  makers.length === 0
                    ? "Pick a name — ports and fee policy are set for you."
                    : "Choose another status filter."
                }
                action={
                  makers.length === 0 ? (
                    <LinkButton to="/maker/new">
                      <Plus size={15} />
                      Create maker
                    </LinkButton>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {visibleMakers.map((maker, i) => (
                <motion.div
                  key={maker.settings.makerId}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.42,
                    delay: i * 0.07,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                >
                  <MakerCard maker={maker} onChanged={refresh} />
                </motion.div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
