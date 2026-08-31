import {
  AlertTriangle,
  CircleDollarSign,
  Copy,
  LockKeyhole,
  Play,
  RefreshCw,
  Save,
  Square,
  Trash2,
  WalletCards,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  clearMakerSettings,
  getMakerBalances,
  getMakerInfo,
  getMakerLogs,
  getMakerNewAddress,
  getMakerStatus,
  getMakerTransactions,
  getSavedMakerSettings,
  listMakerFidelityBonds,
  listMakerSwapReports,
  listMakerUtxos,
  startMaker,
  stopMaker,
  syncMakerWallet,
  updateMakerSettings,
} from "../../api/commands";
import { isAppError } from "../../api/types";
import type {
  Balances,
  FidelityBond,
  LogLine,
  MakerSettings,
  MakerStatus,
  MakerSwapReportSummary,
  NewAddress,
  TxSummary,
  UtxoEntry,
  WalletInfo,
} from "../../api/types";
import {
  BackButton,
  Card,
  LogViewer,
  Modal,
  SatsAmount,
  SettingsSection,
  SkeletonLines,
} from "../../components/ui/display";
import {
  Button,
  PasswordField,
  SegmentedToggle,
  SummaryGroup,
  SummaryRow,
} from "../../components/ui/inputs";
import { formatTorEndpoint } from "../../lib/market-format";
import {
  formatRelativeTime,
  logLevel,
  type LogLevel,
} from "../../lib/wallet-format";
import { useToastStore } from "../../store/toast";

type Tab = "overview" | "wallet" | "logs" | "settings";
const TAB_OPTIONS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "wallet", label: "Wallet" },
  { value: "logs", label: "Logs" },
  { value: "settings", label: "Settings" },
];

function DataMetric({
  label,
  value,
  detail,
  icon,
  tone = "text-foreground",
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
  icon: React.ReactNode;
  tone?: string;
}) {
  const accent = tone.includes("success")
    ? "bg-success"
    : tone.includes("warning")
      ? "bg-warning"
      : "bg-primary";
  return (
    <Card className="group min-h-[138px] border-line-strong p-5 transition-colors duration-200 hover:border-primary/30">
      <div className={`absolute inset-x-5 top-0 h-px ${accent} opacity-55`} />
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">{label}</span>
        <span className={`grid h-7 w-7 place-items-center rounded-control border border-line bg-surface/65 ${tone}`}>{icon}</span>
      </div>
      <strong className={`mt-3 block font-mono text-[24px] tracking-tight ${tone}`}>
        {value}
      </strong>
      <span className="mt-2 block text-[11px] text-muted">{detail}</span>
    </Card>
  );
}

function OverviewPanel({
  status,
  settings,
  info,
  balances,
  bonds,
  reports,
}: {
  status: MakerStatus;
  settings: MakerSettings;
  info: WalletInfo;
  balances: Balances | null;
  bonds: FidelityBond[];
  reports: MakerSwapReportSummary[];
}) {
  const total = balances
    ? balances.regular + balances.swap + balances.contract + balances.fidelity
    : 0;
  const earnings = reports.reduce(
    (sum, report) => sum + report.feeEarnedSats,
    0,
  );
  return (
    <div className="space-y-4">
      {balances ? (
        <div className="grid grid-cols-[1.45fr_repeat(2,1fr)] gap-4 max-[1000px]:grid-cols-2 max-[680px]:grid-cols-1">
          <Card className="row-span-2 border-primary/30 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_18px_55px_-38px_color-mix(in_oklab,var(--color-primary)_65%,transparent)] max-[1000px]:col-span-2 max-[680px]:col-span-1">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Total maker balance</span>
              <span className="grid h-8 w-8 place-items-center rounded-control border border-primary/25 bg-primary/10 text-primary"><WalletCards size={15} /></span>
            </div>
            <strong className="mt-4 block font-mono text-[38px] text-primary">
              <SatsAmount sats={total} />
            </strong>
            <p className="mt-2 text-[12px] text-muted">
              Regular + swap + contract + fidelity
            </p>
            <div
              className="mt-6 grid grid-cols-2 overflow-hidden rounded-control border border-line bg-line
                [&>*]:bg-surface/75 [&>*]:p-3 [&>*:nth-child(odd)]:mr-px [&>*:nth-child(-n+2)]:mb-px"
            >
              <span className="text-[11px] text-muted">
                Regular{" "}
                <strong className="mt-1 block font-mono text-foreground">
                  <SatsAmount sats={balances.regular} />
                </strong>
              </span>
              <span className="text-[11px] text-muted">
                Swap{" "}
                <strong className="mt-1 block font-mono text-success">
                  <SatsAmount sats={balances.swap} />
                </strong>
              </span>
              <span className="text-[11px] text-muted">
                Contract{" "}
                <strong className="mt-1 block font-mono text-warning">
                  <SatsAmount sats={balances.contract} />
                </strong>
              </span>
              <span className="text-[11px] text-muted">
                Fidelity{" "}
                <strong className="mt-1 block font-mono text-warning">
                  <SatsAmount sats={balances.fidelity} />
                </strong>
              </span>
            </div>
          </Card>
          <DataMetric
            label="Spendable"
            value={<SatsAmount sats={balances.spendable} />}
            detail="Regular and swap funds available"
            icon={<WalletCards size={14} />}
            tone="text-primary"
          />
          <DataMetric
            label="Net earnings"
            value={<SatsAmount sats={earnings} />}
            detail={`${reports.length} saved swap reports`}
            icon={<CircleDollarSign size={14} />}
            tone="text-success"
          />
          <DataMetric
            label="Fidelity bonds"
            value={bonds.filter((bond) => bond.isLocked).length}
            detail={`${bonds.length} bond records`}
            icon={<ShieldCheck size={14} />}
            tone="text-warning"
          />
          <DataMetric
            label="Contract balance"
            value={<SatsAmount sats={balances.contract} />}
            detail="Funds currently locked in contracts"
            icon={<LockKeyhole size={14} />}
            tone="text-warning"
          />
        </div>
      ) : (
        <Card className="grid min-h-[220px] place-items-center border-dashed border-line-strong p-8 text-center">
          <div>
            <WalletCards size={34} className="mx-auto text-primary" />
            <strong className="mt-3 block text-[14px]">
              Start the maker to load wallet data
            </strong>
            <span className="mt-1 block text-[12px] text-muted">
              Saved configuration remains available while the runtime is
              stopped.
            </span>
          </div>
        </Card>
      )}
      <Card className="border-line-strong">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-header text-[14px] font-bold">Runtime configuration</h2>
          <span className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-subtle">
            <i className={`h-1.5 w-1.5 rounded-full ${status.running ? "bg-success" : "bg-subtle"}`} /> {status.phase.phase}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-px bg-line max-[800px]:grid-cols-1">
          {[
            { label: "Wallet", value: info.walletName, title: info.walletName },
            {
              label: "Data directory",
              value: info.dataDir,
              title: info.dataDir,
            },
            {
              label: "Ports",
              value: `${settings.networkPort} / ${settings.rpcPort}`,
            },
            {
              label: "Tor",
              value: `${settings.socksPort} / ${settings.controlPort}`,
            },
            {
              label: "Minimum swap",
              value: <SatsAmount sats={settings.minSwapAmount} />,
            },
            { label: "Status", value: status.phase.phase },
          ].map(({ label, value, title }) => (
            <div key={label} className="min-w-0 bg-surface/80 p-4 transition-colors duration-200 hover:bg-white/[0.035]">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                {label}
              </span>
              <strong
                className="mt-1.5 block truncate font-mono text-[11.5px] text-foreground"
                title={title}
              >
                {value}
              </strong>
            </div>
          ))}
        </div>
      </Card>
      <ReportList makerId={settings.makerId} reports={reports} />
    </div>
  );
}

function ReportList({
  makerId,
  reports,
}: {
  makerId: string;
  reports: MakerSwapReportSummary[];
}) {
  return (
    <Card className="border-line-strong">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 className="font-header text-[14px] font-bold">Swap reports</h2>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
          {reports.length} reports
        </span>
      </div>
      {reports.length === 0 ? (
        <p className="p-8 text-center text-[12px] text-subtle">
          Completed maker swaps will appear here.
        </p>
      ) : (
        <div className="divide-y divide-line">
          {reports.slice(0, 10).map((report) => (
            <Link
              key={report.swapId}
              to={`/maker/${encodeURIComponent(makerId)}/report/${encodeURIComponent(report.swapId)}`}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-5 px-5 py-3.5 hover:bg-[var(--color-hover)]"
            >
              <div className="min-w-0">
                <strong className="block truncate font-mono text-[11.5px]">
                  {report.swapId}
                </strong>
                <span className="mt-1 block text-[10px] text-subtle">
                  {formatRelativeTime(report.endTimestamp)}
                </span>
              </div>
              <span className="rounded-pill border border-line px-2 py-1 font-mono text-[9px] uppercase text-muted">
                {report.status}
              </span>
              <strong className="font-mono text-[12px] text-success">
                +<SatsAmount sats={report.feeEarnedSats} />
              </strong>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function WalletPanel({
  makerId,
  running,
}: {
  makerId: string;
  running: boolean;
}) {
  const pushToast = useToastStore((state) => state.push);
  const [utxos, setUtxos] = useState<UtxoEntry[]>([]);
  const [transactions, setTransactions] = useState<TxSummary[]>([]);
  const [address, setAddress] = useState<NewAddress | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!running) return;
    setLoading(true);
    const [u, t] = await Promise.all([
      listMakerUtxos(makerId),
      getMakerTransactions(makerId, 30, 0),
    ]);
    setUtxos(u);
    setTransactions(t);
    setLoading(false);
  }, [makerId, running]);
  useEffect(() => {
    void load().catch(() => setLoading(false));
  }, [load]);
  if (!running)
    return (
      <Card className="grid min-h-[300px] place-items-center border-dashed border-line-strong text-center">
        <div>
          <WalletCards className="mx-auto text-primary" />
          <strong className="mt-3 block">Maker wallet is offline</strong>
          <span className="mt-1 block text-[12px] text-muted">
            Start the maker to receive, sync, and inspect UTXOs.
          </span>
        </div>
      </Card>
    );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 max-[780px]:grid-cols-1">
        <Card className="border-line-strong p-5">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
            Receive Bitcoin
          </span>
          {address ? (
            <code
              className="mt-4 block break-all rounded-control border border-line bg-surface p-3
                text-[11px] text-foreground"
            >
              {address.address}
            </code>
          ) : (
            <p className="mt-4 text-[12px] text-muted">
              Generate a fresh P2WPKH maker-wallet address.
            </p>
          )}
          <Button
            className="mt-4 w-full"
            onClick={() =>
              void getMakerNewAddress(makerId, "p2wpkh")
                .then(setAddress)
                .catch((e) => pushToast("error", e.message))
            }
          >
            Generate address
          </Button>
        </Card>
        <Card className="border-line-strong p-5">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
            Wallet synchronization
          </span>
          <p className="mt-4 text-[12px] leading-5 text-muted">
            Refresh the maker wallet from its configured chain backend before
            spending or reviewing balances.
          </p>
          <Button
            variant="secondary"
            className="mt-4 w-full"
            loading={loading}
            onClick={() =>
              void syncMakerWallet(makerId)
                .then(load)
                .catch((e) => pushToast("error", e.message))
            }
          >
            <RefreshCw size={14} />
            Sync wallet
          </Button>
        </Card>
      </div>
      <Card className="border-line-strong">
        <div className="border-b border-line px-5 py-4">
          <h2 className="font-header text-[14px] font-bold">
            UTXOs{" "}
            <span className="ml-2 font-mono text-[10px] text-subtle">
              {utxos.length}
            </span>
          </h2>
        </div>
        <div className="max-h-[330px] overflow-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-subtle">
                <th className="px-5 py-3">Outpoint</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Confirmations</th>
                <th className="px-5 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {utxos.map((utxo) => (
                <tr key={`${utxo.txid}:${utxo.vout}`}>
                  <td
                    className="max-w-[260px] truncate px-5 py-3 font-mono"
                    title={`${utxo.txid}:${utxo.vout}`}
                  >
                    {utxo.txid.slice(0, 14)}…:{utxo.vout}
                  </td>
                  <td className="px-5 py-3 text-muted">{utxo.spendType}</td>
                  <td className="px-5 py-3 font-mono">{utxo.confirmations}</td>
                  <td className="px-5 py-3 text-right font-mono">
                    <SatsAmount sats={utxo.amountSats} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {utxos.length === 0 && (
            <p className="p-8 text-center text-subtle">No UTXOs found.</p>
          )}
        </div>
      </Card>
      <Card className="border-line-strong">
        <div className="border-b border-line px-5 py-4">
          <h2 className="font-header text-[14px] font-bold">
            Recent transactions
          </h2>
        </div>
        <div className="divide-y divide-line">
          {transactions.slice(0, 8).map((tx) => (
            <div
              key={`${tx.txid}:${tx.category}`}
              className="flex items-center justify-between gap-4 px-5 py-3"
            >
              <code className="min-w-0 truncate text-[11px] text-muted">
                {tx.txid}
              </code>
              <strong
                className={`font-mono text-[11.5px] ${tx.amountSats >= 0 ? "text-success" : "text-danger"}`}
              >
                <SatsAmount sats={tx.amountSats} />
              </strong>
            </div>
          ))}
          {transactions.length === 0 && (
            <p className="p-8 text-center text-subtle">
              No transactions found.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

type MakerLogFilter = "all" | "info" | "warn" | "error";

function LogsPanel({ makerId }: { makerId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState<MakerLogFilter>("all");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLines(await getMakerLogs(makerId, 500));
    } finally {
      setLoading(false);
    }
  }, [makerId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  const counts = useMemo(
    () =>
      lines.reduce(
        (result, row) => {
          const level = logLevel(row.line);
          result[level] += 1;
          return result;
        },
        { error: 0, warn: 0, info: 0, debug: 0, other: 0 } as Record<LogLevel, number>,
      ),
    [lines],
  );
  const filteredLines = useMemo(
    () =>
      levelFilter === "all"
        ? lines
        : lines.filter((line) => logLevel(line.line) === levelFilter),
    [levelFilter, lines],
  );
  return (
    <Card className="flex h-[580px] flex-col border-line-strong">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h2 className="font-header text-[14px] font-bold">Maker logs</h2>
          <span className="text-[10px] text-subtle">
            Latest 500 lines · refreshes every 3 seconds
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedToggle
            groupId={`maker-log-level-${makerId}`}
            subdued
            value={levelFilter}
            onChange={setLevelFilter}
            options={[
              { value: "all", label: "All", suffix: <span className="font-mono text-[9px] opacity-60">{lines.length}</span> },
              { value: "info", label: "Info", suffix: <span className="font-mono text-[9px] opacity-60">{counts.info}</span> },
              { value: "warn", label: "Warn", suffix: <span className="font-mono text-[9px] opacity-60">{counts.warn}</span> },
              { value: "error", label: "Error", suffix: <span className="font-mono text-[9px] opacity-60">{counts.error}</span> },
            ]}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load()}
            loading={loading}
          >
            <RefreshCw size={13} />
            Refresh
          </Button>
        </div>
      </div>
      <LogViewer
        lines={filteredLines}
        emptyMessage={
          lines.length === 0
            ? "No log lines yet."
            : `No ${levelFilter} log entries in the latest 500 lines.`
        }
      />
    </Card>
  );
}

const EDITABLE_SETTING_KEYS = [
  "networkPort",
  "rpcPort",
  "requiredConfirms",
  "socksPort",
  "controlPort",
  "minSwapAmount",
  "baseFee",
  "amountRelativeFeePct",
  "timeRelativeFeePct",
  "fidelityAmount",
  "fidelityTimelock",
] as const;
type EditableSettingKey = (typeof EDITABLE_SETTING_KEYS)[number];
type SettingsForm = Record<EditableSettingKey, string>;

function settingsToForm(settings: MakerSettings): SettingsForm {
  return Object.fromEntries(
    EDITABLE_SETTING_KEYS.map((key) => [key, String(settings[key])]),
  ) as SettingsForm;
}

function parseSettingsForm(
  settings: MakerSettings,
  form: SettingsForm,
): MakerSettings | string {
  const values = Object.fromEntries(
    EDITABLE_SETTING_KEYS.map((key) => [key, Number(form[key])]),
  ) as Record<EditableSettingKey, number>;
  const integers: EditableSettingKey[] = [
    "networkPort",
    "rpcPort",
    "requiredConfirms",
    "socksPort",
    "controlPort",
    "minSwapAmount",
    "baseFee",
    "fidelityAmount",
    "fidelityTimelock",
  ];
  if (
    EDITABLE_SETTING_KEYS.some(
      (key) => !Number.isFinite(values[key]) || values[key] < 0,
    )
  ) {
    return "All settings must be valid non-negative numbers.";
  }
  if (integers.some((key) => !Number.isSafeInteger(values[key]))) {
    return "Ports, amounts, confirmations, and timelocks must be whole numbers.";
  }
  const ports = [
    values.networkPort,
    values.rpcPort,
    values.socksPort,
    values.controlPort,
  ];
  if (ports.some((port) => port < 1 || port > 65_535))
    return "Ports must be between 1 and 65535.";
  if (new Set(ports).size !== ports.length)
    return "Network, RPC, SOCKS, and control ports must be different.";
  if (values.minSwapAmount < 10_000)
    return "Minimum swap amount must be at least 10,000 sats.";
  if (values.fidelityAmount < 1)
    return "Fidelity amount must be greater than zero.";
  if (values.requiredConfirms < 1)
    return "Required confirmations must be at least one.";
  if (values.fidelityTimelock < 12_960 || values.fidelityTimelock > 25_920) {
    return "Fidelity timelock must be between 12,960 and 25,920 blocks.";
  }
  return { ...settings, ...values };
}

function SettingsPanel({
  settings,
  makerId,
  running,
  transitioning,
  onSaved,
}: {
  settings: MakerSettings;
  makerId: string;
  running: boolean;
  transitioning: boolean;
  onSaved: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);
  const [form, setForm] = useState<SettingsForm>(() =>
    settingsToForm(settings),
  );
  const [saving, setSaving] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setForm(settingsToForm(settings)), [makerId]);

  const parsed = parseSettingsForm(settings, form);
  const error = typeof parsed === "string" ? parsed : null;
  const dirty = EDITABLE_SETTING_KEYS.some(
    (key) => form[key] !== String(settings[key]),
  );
  const row = (
    key: EditableSettingKey,
    label: string,
    options: {
      suffix?: string;
      hint?: string;
      inputMode?: "numeric" | "decimal";
    } = {},
  ) => (
    <SummaryRow
      label={label}
      value={form[key]}
      suffix={options.suffix}
      hint={options.hint}
      inputMode={options.inputMode}
      readOnly={transitioning || saving}
      onCommit={(value) => setForm((current) => ({ ...current, [key]: value }))}
    />
  );

  async function save(next: MakerSettings) {
    const shouldStop = running;
    let settingsWereSaved = false;
    setSaving(true);
    try {
      if (shouldStop) await stopMaker(makerId);
      const saved = await updateMakerSettings(makerId, next);
      settingsWereSaved = true;
      setForm(settingsToForm(saved));
      setConfirmSave(false);
      await onSaved();
      pushToast(
        "success",
        shouldStop
          ? "Maker settings saved. Re-enter the wallet password to restart the maker."
          : "Maker settings saved to config.toml.",
      );
    } catch (e) {
      await onSaved().catch(() => {});
      const message =
        (e as { message?: string }).message ?? "Could not save maker settings.";
      pushToast(
        "error",
        settingsWereSaved
          ? `Settings were saved, but the view could not refresh: ${message}`
          : shouldStop
            ? `Could not apply settings. The maker may be stopped: ${message}`
            : message,
      );
    } finally {
      setSaving(false);
    }
  }

  function requestSave() {
    if (typeof parsed === "string" || transitioning) return;
    setConfirmSave(true);
  }

  return (
    <div className="space-y-4">
      {transitioning ? (
        <div className="rounded-control border border-warning/35 bg-warning/[0.08] px-4 py-3 text-[12px] text-warning">
          Wait for the current maker operation to finish before editing settings.
        </div>
      ) : running ? (
        <div className="rounded-control border border-primary/30 bg-primary/[0.07] px-4 py-3 text-[12px] text-primary">
          Saving changes stops this maker and writes its config.toml. Re-enter
          its wallet password afterwards to start it again.
        </div>
      ) : null}
      <Card className="border-line-strong p-5">
        <div className="grid grid-cols-3 gap-4 max-[760px]:grid-cols-1">
          {[
            ["Maker ID", settings.makerId],
            ["Wallet", settings.walletName],
            ["Data directory", settings.dataDir ?? "Default"],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                {label}
              </span>
              <strong
                className="mt-1.5 block truncate font-mono text-[11px]"
                title={value}
              >
                {value}
              </strong>
            </div>
          ))}
        </div>
        <p className="mt-4 border-t border-line pt-3 text-[11px] text-muted">
          Maker identity and wallet location are fixed to prevent accidentally
          pointing this maker at another wallet.
        </p>
      </Card>
      <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <SettingsSection
          title="Network"
          subtitle="Inbound maker and local RPC listeners"
        >
          <div className="col-span-2 max-[620px]:col-span-1">
            <SummaryGroup title="Listeners">
              {row("networkPort", "Network port", {
                hint: "Keep fixed after bonding",
              })}
              {row("rpcPort", "RPC port")}
              {row("requiredConfirms", "Required confirmations")}
            </SummaryGroup>
          </div>
        </SettingsSection>
        <SettingsSection
          title="Tor"
          subtitle="Shared Tor SOCKS and control service"
        >
          <div className="col-span-2 max-[620px]:col-span-1">
            <SummaryGroup title="Tor ports">
              {row("socksPort", "SOCKS port")}
              {row("controlPort", "Control port")}
            </SummaryGroup>
          </div>
        </SettingsSection>
        <SettingsSection
          title="Swap policy"
          subtitle="Minimum size and advertised maker fees"
        >
          <div className="col-span-2 max-[620px]:col-span-1">
            <SummaryGroup title="Advertised policy">
              {row("minSwapAmount", "Minimum swap amount", { suffix: "sats" })}
              {row("baseFee", "Base fee", { suffix: "sats" })}
              {row("amountRelativeFeePct", "Amount-relative fee", {
                suffix: "%",
                inputMode: "decimal",
              })}
              {row("timeRelativeFeePct", "Time-relative fee", {
                suffix: "%",
                inputMode: "decimal",
              })}
            </SummaryGroup>
          </div>
        </SettingsSection>
        <SettingsSection
          title="Fidelity"
          subtitle="Defaults used when creating future fidelity bonds"
        >
          <div className="col-span-2 max-[620px]:col-span-1">
            <SummaryGroup title="Bond defaults">
              {row("fidelityAmount", "Target amount", { suffix: "sats" })}
              {row("fidelityTimelock", "Timelock", { suffix: "blocks" })}
            </SummaryGroup>
          </div>
        </SettingsSection>
      </div>
      <Card className="border-line-strong p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-header text-[14px] font-bold">
              Save configuration
            </h2>
            <p
              className={`mt-1 text-[11.5px] ${error ? "text-danger" : "text-muted"}`}
            >
              {error ??
                (dirty
                  ? running
                    ? "Unsaved changes will be written to config.toml, then the maker stops until you start it again."
                    : "Unsaved changes will be written to this maker’s config.toml."
                  : "config.toml is up to date.")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={!dirty || saving}
              onClick={() => setForm(settingsToForm(settings))}
            >
              Discard
            </Button>
            <Button
              disabled={transitioning || !dirty || !!error}
              loading={saving}
              onClick={requestSave}
            >
              <Save size={14} />
              {running ? "Save & stop" : "Save changes"}
            </Button>
          </div>
        </div>
      </Card>
      <Card className="border-danger/30 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-header text-[14px] font-bold text-danger">
              Remove this maker
            </h2>
            <p className="mt-1 text-[11.5px] text-muted">
              Stops managing this maker here. Wallet files and on-chain funds
              are not deleted.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={transitioning || running}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 size={14} />
            Remove
          </Button>
        </div>
      </Card>
      {confirmSave && typeof parsed !== "string" && (
        <Modal
          title={running ? "Save and stop maker?" : "Save maker settings?"}
          onClose={() => setConfirmSave(false)}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setConfirmSave(false)}
              >
                Cancel
              </Button>
              <Button onClick={() => void save(parsed)} loading={saving}>
                {running ? "Save & stop" : "Save changes"}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-[12px] leading-5 text-muted">
            <p>
              The changes will be written to this maker’s config.toml.
              {running && " The maker will stop; re-enter its wallet password to restart it."}
            </p>
            {parsed.networkPort !== settings.networkPort && (
              <div className="flex gap-3 rounded-control border border-warning/30 bg-warning/[0.07] p-3">
                <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={18} />
                <p>
                  A fidelity bond commits to the maker address using network port{" "}
                  <strong className="text-foreground">{settings.networkPort}</strong>.
                  Changing it to{" "}
                  <strong className="text-foreground">{parsed.networkPort}</strong>{" "}
                  can make an existing bond unusable for this maker. Continue only
                  if there is no active fidelity bond or you understand the migration.
                </p>
              </div>
            )}
          </div>
        </Modal>
      )}
      {confirmRemove && (
        <Modal
          title={`Remove ${makerId}?`}
          onClose={() => setConfirmRemove(false)}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={() =>
                  void clearMakerSettings(makerId)
                    .then(() => {
                      pushToast("success", `${makerId} was removed.`);
                      navigate("/maker");
                    })
                    .catch((e) => pushToast("error", e.message))
                }
              >
                Remove maker
              </Button>
            </>
          }
        >
          <p className="text-[12px] leading-5 text-muted">
            This removes <strong className="text-foreground">{makerId}</strong>{" "}
            from the app, permanently — it will not reappear. Its wallet file
            and anything on-chain are left untouched.
          </p>
        </Modal>
      )}
    </div>
  );
}

export function MakerWorkspacePage() {
  const { makerId = "" } = useParams();
  const id = decodeURIComponent(makerId);
  const pushToast = useToastStore((s) => s.push);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as Tab | null;
  const tab = TAB_OPTIONS.some((item) => item.value === requestedTab)
    ? requestedTab!
    : "overview";
  const [status, setStatus] = useState<MakerStatus | null>(null);
  const [settings, setSettings] = useState<MakerSettings | null>(null);
  const [info, setInfo] = useState<WalletInfo | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [bonds, setBonds] = useState<FidelityBond[]>([]);
  const [reports, setReports] = useState<MakerSwapReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [walletPassword, setWalletPassword] = useState("");
  const [startError, setStartError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    const [nextStatus, nextSettings, nextInfo] = await Promise.all([
      getMakerStatus(id),
      getSavedMakerSettings(id),
      getMakerInfo(id),
    ]);
    if (!nextSettings) throw new Error("This maker was not found.");
    setStatus(nextStatus);
    setSettings(nextSettings);
    setInfo(nextInfo);
    const [b, f, r] = await Promise.allSettled([
      getMakerBalances(id),
      listMakerFidelityBonds(id),
      listMakerSwapReports(id),
    ]);
    setBalances(b.status === "fulfilled" ? b.value : null);
    setBonds(f.status === "fulfilled" ? f.value : []);
    setReports(r.status === "fulfilled" ? r.value : []);
    setLoading(false);
  }, [id]);
  useEffect(() => {
    void load().catch((e) => {
      pushToast("error", e.message);
      setLoading(false);
    });
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [load, pushToast]);
  const phase = status?.phase.phase ?? "notConfigured";
  const running = phase === "running" || phase === "starting";
  const transitioning = ["initializing", "starting", "stopping"].includes(
    phase,
  );
  async function start() {
    setActionLoading(true);
    setStartError(undefined);
    try {
      await startMaker(id, walletPassword || undefined);
      setShowStart(false);
      setWalletPassword("");
      await load();
    } catch (e) {
      setStartError(
        isAppError(e) && e.code === "WALLET_WRONG_PASSWORD"
          ? "Wrong password for this maker's wallet."
          : ((e as { message?: string }).message ?? "Could not start maker."),
      );
    } finally {
      setActionLoading(false);
    }
  }
  async function stop() {
    setActionLoading(true);
    try {
      await stopMaker(id);
      await load();
    } catch (e) {
      pushToast(
        "error",
        (e as { message?: string }).message ?? "Could not stop maker.",
      );
    } finally {
      setActionLoading(false);
    }
  }
  if (loading || !status || !settings || !info)
    return (
      <div className="mx-auto w-full max-w-xl pt-20">
        <SkeletonLines count={10} />
      </div>
    );
  const tor = status.torAddress;
  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[1380px] pb-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <BackButton to="/maker" label="Back to makers" />
            <div className="min-w-0">
              <span className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-primary">Maker workspace · Signet</span>
              <div className="flex items-center gap-2">
                <h1 className="truncate font-header text-[27px] font-bold">
                  {id}
                </h1>
                <span
                  className={`h-2 w-2 rounded-full ${
                    phase === "running"
                      ? "bg-success"
                      : phase === "failed"
                        ? "bg-danger"
                        : transitioning
                          ? "bg-warning"
                          : "bg-subtle"
                  }`}
                />
              </div>
              <button
                type="button"
                disabled={!tor}
                onClick={() =>
                  tor &&
                  navigator.clipboard.writeText(tor).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  })
                }
                className="mt-1 flex max-w-full items-center gap-2 text-left font-mono text-[10.5px]
                  text-subtle disabled:cursor-default"
              >
                <span className="truncate">
                  {tor
                    ? formatTorEndpoint(tor, 24, 14, true)
                    : `Status · ${phase}`}
                </span>
                {tor && (
                  <Copy size={12} className={copied ? "text-success" : ""} />
                )}
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            {running ? (
              <Button
                onClick={() => void stop()}
                loading={actionLoading}
                disabled={transitioning}
              >
                <Square size={13} />
                Stop maker
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setWalletPassword("");
                  setStartError(undefined);
                  setShowStart(true);
                }}
                disabled={transitioning}
              >
                <Play size={13} />
                Start maker
              </Button>
            )}
          </div>
        </header>
        {phase === "failed" && status.phase.phase === "failed" && (
          <div
            className="mt-4 rounded-control border border-danger/35 bg-danger/[0.08]
              px-4 py-3 text-[12px] text-danger"
          >
            {status.phase.message}
          </div>
        )}
        <div className="mt-6 border-b border-line">
          <SegmentedToggle
            groupId="maker-workspace-tabs"
            value={tab}
            onChange={(value) =>
              setSearchParams(value === "overview" ? {} : { tab: value })
            }
            options={TAB_OPTIONS}
          />
        </div>
        <main className="mt-5">
          {tab === "overview" && (
            <OverviewPanel
              status={status}
              settings={settings}
              info={info}
              balances={balances}
              bonds={bonds}
              reports={reports}
            />
          )}
          {tab === "wallet" && <WalletPanel makerId={id} running={running} />}
          {tab === "logs" && <LogsPanel makerId={id} />}
          {tab === "settings" && (
            <SettingsPanel
              settings={settings}
              makerId={id}
              running={running}
              transitioning={transitioning}
              onSaved={load}
            />
          )}
        </main>
        {showStart && (
          <Modal
            title={`Start ${id}`}
            onClose={() => setShowStart(false)}
            footer={
              <>
                <Button variant="secondary" onClick={() => setShowStart(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void start()}
                  loading={actionLoading}
                  disabled={status.walletEncrypted === true && !walletPassword}
                >
                  Start maker
                </Button>
              </>
            }
          >
            <p className="text-[12px] text-muted">
              Passwords stay in memory for this process and are never written to
              disk.
            </p>
            {status.walletEncrypted !== false && (
              <PasswordField
                label={
                  status.walletEncrypted
                    ? "Wallet password"
                    : "Wallet password (if encrypted)"
                }
                autoComplete="current-password"
                value={walletPassword}
                onChange={(e) => setWalletPassword(e.target.value)}
                error={startError}
                onKeyDown={(e) => e.key === "Enter" && void start()}
              />
            )}
            {startError && status.walletEncrypted === false && (
              <p className="mt-2 text-[12px] text-danger">{startError}</p>
            )}
          </Modal>
        )}
      </div>
    </div>
  );
}
