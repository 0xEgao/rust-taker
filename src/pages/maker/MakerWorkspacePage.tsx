import { AlertTriangle, ArrowLeft, Copy, Play, RefreshCw, Save, Square, Trash2, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import type { Balances, FidelityBond, LogLine, MakerSettings, MakerStatus, MakerSwapReportSummary, NewAddress, TxSummary, UtxoEntry, WalletInfo } from "../../api/types";
import { Card, LogViewer, Modal, SatsAmount } from "../../components/ui/display";
import { Button, PasswordField, SegmentedToggle, TextField } from "../../components/ui/inputs";
import { formatTorEndpoint } from "../../lib/market-format";
import { formatRelativeTime } from "../../lib/wallet-format";
import { useToastStore } from "../../store/toast";

type Tab = "overview" | "wallet" | "logs" | "settings";
const TAB_OPTIONS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Overview" }, { value: "wallet", label: "Wallet" }, { value: "logs", label: "Logs" }, { value: "settings", label: "Settings" },
];

function DataMetric({ label, value, detail, tone = "text-foreground" }: { label: string; value: React.ReactNode; detail: string; tone?: string }) {
  return <Card className="min-h-[130px] border-line-strong p-5"><span className="font-mono text-[10px] uppercase tracking-widest text-subtle">{label}</span><strong className={`mt-3 block font-mono text-[24px] ${tone}`}>{value}</strong><span className="mt-2 block text-[11.5px] text-muted">{detail}</span></Card>;
}

function OverviewPanel({ status, settings, info, balances, bonds, reports }: { status: MakerStatus; settings: MakerSettings; info: WalletInfo; balances: Balances | null; bonds: FidelityBond[]; reports: MakerSwapReportSummary[] }) {
  const total = balances ? balances.regular + balances.swap + balances.contract + balances.fidelity : 0;
  const earnings = reports.reduce((sum, report) => sum + report.feeEarnedSats, 0);
  return <div className="space-y-4">
    {balances ? <div className="grid grid-cols-[1.45fr_repeat(2,1fr)] gap-4 max-[1000px]:grid-cols-2 max-[680px]:grid-cols-1">
      <Card className="row-span-2 border-primary/25 p-6 max-[1000px]:col-span-2 max-[680px]:col-span-1"><span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Total maker balance</span><strong className="mt-4 block font-mono text-[38px] text-primary"><SatsAmount sats={total} /></strong><p className="mt-2 text-[12px] text-muted">Regular + swap + contract + fidelity</p><div className="mt-6 grid grid-cols-2 overflow-hidden rounded-control border border-line bg-line [&>*]:bg-surface/75 [&>*]:p-3 [&>*:nth-child(odd)]:mr-px [&>*:nth-child(-n+2)]:mb-px"><span className="text-[11px] text-muted">Regular <strong className="mt-1 block font-mono text-foreground"><SatsAmount sats={balances.regular} /></strong></span><span className="text-[11px] text-muted">Swap <strong className="mt-1 block font-mono text-success"><SatsAmount sats={balances.swap} /></strong></span><span className="text-[11px] text-muted">Contract <strong className="mt-1 block font-mono text-warning"><SatsAmount sats={balances.contract} /></strong></span><span className="text-[11px] text-muted">Fidelity <strong className="mt-1 block font-mono text-warning"><SatsAmount sats={balances.fidelity} /></strong></span></div></Card>
      <DataMetric label="Spendable" value={<SatsAmount sats={balances.spendable} />} detail="Regular and swap funds available" tone="text-primary" />
      <DataMetric label="Net earnings" value={<SatsAmount sats={earnings} />} detail={`${reports.length} saved swap reports`} tone="text-success" />
      <DataMetric label="Fidelity bonds" value={bonds.filter((bond) => bond.isLocked).length} detail={`${bonds.length} bond records`} tone="text-warning" />
      <DataMetric label="Contract balance" value={<SatsAmount sats={balances.contract} />} detail="Funds currently locked in contracts" tone="text-warning" />
    </div> : <Card className="grid min-h-[220px] place-items-center border-dashed border-line-strong p-8 text-center"><div><WalletCards size={34} className="mx-auto text-primary" /><strong className="mt-3 block text-[14px]">Start the maker to load wallet data</strong><span className="mt-1 block text-[12px] text-muted">Saved configuration remains available while the runtime is stopped.</span></div></Card>}
    <Card className="border-line-strong"><div className="border-b border-line px-5 py-4"><h2 className="font-header text-[14px] font-bold">Runtime configuration</h2></div><div className="grid grid-cols-3 gap-px bg-line max-[800px]:grid-cols-1">{[["Wallet", info.walletName], ["Data directory", info.dataDir], ["Ports", `${settings.networkPort} / ${settings.rpcPort}`], ["Tor", `${settings.socksPort} / ${settings.controlPort}`], ["Minimum swap", `${settings.minSwapAmount.toLocaleString()} sats`], ["Status", status.phase.phase]].map(([label, value]) => <div key={label} className="min-w-0 bg-surface/80 p-4"><span className="font-mono text-[9px] uppercase tracking-widest text-subtle">{label}</span><strong className="mt-1.5 block truncate font-mono text-[11.5px] text-foreground" title={value}>{value}</strong></div>)}</div></Card>
    <ReportList makerId={settings.makerId} reports={reports} />
  </div>;
}

function ReportList({ makerId, reports }: { makerId: string; reports: MakerSwapReportSummary[] }) {
  return <Card className="border-line-strong"><div className="flex items-center justify-between border-b border-line px-5 py-4"><h2 className="font-header text-[14px] font-bold">Swap reports</h2><span className="font-mono text-[10px] uppercase tracking-widest text-subtle">{reports.length} reports</span></div>{reports.length === 0 ? <p className="p-8 text-center text-[12px] text-subtle">Completed maker swaps will appear here.</p> : <div className="divide-y divide-line">{reports.slice(0, 10).map((report) => <Link key={report.swapId} to={`/maker/${encodeURIComponent(makerId)}/report/${encodeURIComponent(report.swapId)}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-5 px-5 py-3.5 hover:bg-white/[0.025]"><div className="min-w-0"><strong className="block truncate font-mono text-[11.5px]">{report.swapId}</strong><span className="mt-1 block text-[10px] text-subtle">{formatRelativeTime(report.endTimestamp)}</span></div><span className="rounded-pill border border-line px-2 py-1 font-mono text-[9px] uppercase text-muted">{report.status}</span><strong className="font-mono text-[12px] text-success">+<SatsAmount sats={report.feeEarnedSats} /></strong></Link>)}</div>}</Card>;
}

function WalletPanel({ makerId, running }: { makerId: string; running: boolean }) {
  const pushToast = useToastStore((state) => state.push); const [utxos, setUtxos] = useState<UtxoEntry[]>([]); const [transactions, setTransactions] = useState<TxSummary[]>([]); const [address, setAddress] = useState<NewAddress | null>(null); const [loading, setLoading] = useState(false);
  const load = useCallback(async () => { if (!running) return; setLoading(true); const [u, t] = await Promise.all([listMakerUtxos(makerId), getMakerTransactions(makerId, 30, 0)]); setUtxos(u); setTransactions(t); setLoading(false); }, [makerId, running]);
  useEffect(() => { void load().catch(() => setLoading(false)); }, [load]);
  if (!running) return <Card className="grid min-h-[300px] place-items-center border-dashed border-line-strong text-center"><div><WalletCards className="mx-auto text-primary" /><strong className="mt-3 block">Maker wallet is offline</strong><span className="mt-1 block text-[12px] text-muted">Start the maker to receive, sync, and inspect UTXOs.</span></div></Card>;
  return <div className="space-y-4"><div className="grid grid-cols-2 gap-4 max-[780px]:grid-cols-1"><Card className="border-line-strong p-5"><span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Receive Bitcoin</span>{address ? <code className="mt-4 block break-all rounded-control border border-line bg-surface p-3 text-[11px] text-foreground">{address.address}</code> : <p className="mt-4 text-[12px] text-muted">Generate a fresh P2WPKH maker-wallet address.</p>}<Button className="mt-4 w-full" onClick={() => void getMakerNewAddress(makerId, "p2wpkh").then(setAddress).catch((e) => pushToast("error", e.message))}>Generate address</Button></Card><Card className="border-line-strong p-5"><span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Wallet synchronization</span><p className="mt-4 text-[12px] leading-5 text-muted">Refresh the maker wallet from its configured chain backend before spending or reviewing balances.</p><Button variant="secondary" className="mt-4 w-full" loading={loading} onClick={() => void syncMakerWallet(makerId).then(load).catch((e) => pushToast("error", e.message))}><RefreshCw size={14} />Sync wallet</Button></Card></div><Card className="border-line-strong"><div className="border-b border-line px-5 py-4"><h2 className="font-header text-[14px] font-bold">UTXOs <span className="ml-2 font-mono text-[10px] text-subtle">{utxos.length}</span></h2></div><div className="max-h-[330px] overflow-auto"><table className="w-full text-left text-[11px]"><thead className="sticky top-0 bg-surface"><tr className="text-subtle"><th className="px-5 py-3">Outpoint</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Confirmations</th><th className="px-5 py-3 text-right">Amount</th></tr></thead><tbody className="divide-y divide-line">{utxos.map((utxo) => <tr key={`${utxo.txid}:${utxo.vout}`}><td className="max-w-[260px] truncate px-5 py-3 font-mono" title={`${utxo.txid}:${utxo.vout}`}>{utxo.txid.slice(0, 14)}…:{utxo.vout}</td><td className="px-5 py-3 text-muted">{utxo.spendType}</td><td className="px-5 py-3 font-mono">{utxo.confirmations}</td><td className="px-5 py-3 text-right font-mono"><SatsAmount sats={utxo.amountSats} /></td></tr>)}</tbody></table>{utxos.length === 0 && <p className="p-8 text-center text-subtle">No UTXOs found.</p>}</div></Card><Card className="border-line-strong"><div className="border-b border-line px-5 py-4"><h2 className="font-header text-[14px] font-bold">Recent transactions</h2></div><div className="divide-y divide-line">{transactions.slice(0, 8).map((tx) => <div key={`${tx.txid}:${tx.category}`} className="flex items-center justify-between gap-4 px-5 py-3"><code className="min-w-0 truncate text-[11px] text-muted">{tx.txid}</code><strong className={`font-mono text-[11.5px] ${tx.amountSats >= 0 ? "text-success" : "text-danger"}`}><SatsAmount sats={tx.amountSats} /></strong></div>)}{transactions.length === 0 && <p className="p-8 text-center text-subtle">No transactions found.</p>}</div></Card></div>;
}

function LogsPanel({ makerId }: { makerId: string }) { const [lines, setLines] = useState<LogLine[]>([]); const [loading, setLoading] = useState(false); const load = useCallback(async () => { setLoading(true); try { setLines(await getMakerLogs(makerId, 500)); } finally { setLoading(false); } }, [makerId]); useEffect(() => { void load(); const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load]); return <Card className="flex h-[580px] flex-col border-line-strong"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="font-header text-[14px] font-bold">Maker logs</h2><span className="text-[10px] text-subtle">Latest 500 lines · refreshes every 3 seconds</span></div><Button variant="secondary" size="sm" onClick={() => void load()} loading={loading}><RefreshCw size={13} />Refresh</Button></div><LogViewer lines={lines} /></Card>; }

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

function parseSettingsForm(settings: MakerSettings, form: SettingsForm): MakerSettings | string {
  const values = Object.fromEntries(
    EDITABLE_SETTING_KEYS.map((key) => [key, Number(form[key])]),
  ) as Record<EditableSettingKey, number>;
  const integers: EditableSettingKey[] = [
    "networkPort", "rpcPort", "requiredConfirms", "socksPort", "controlPort",
    "minSwapAmount", "baseFee", "fidelityAmount", "fidelityTimelock",
  ];
  if (EDITABLE_SETTING_KEYS.some((key) => !Number.isFinite(values[key]) || values[key] < 0)) {
    return "All settings must be valid non-negative numbers.";
  }
  if (integers.some((key) => !Number.isSafeInteger(values[key]))) {
    return "Ports, amounts, confirmations, and timelocks must be whole numbers.";
  }
  const ports = [values.networkPort, values.rpcPort, values.socksPort, values.controlPort];
  if (ports.some((port) => port < 1 || port > 65_535)) return "Ports must be between 1 and 65535.";
  if (new Set(ports).size !== ports.length) return "Network, RPC, SOCKS, and control ports must be different.";
  if (values.minSwapAmount < 10_000) return "Minimum swap amount must be at least 10,000 sats.";
  if (values.fidelityAmount < 1) return "Fidelity amount must be greater than zero.";
  if (values.requiredConfirms < 1) return "Required confirmations must be at least one.";
  if (values.fidelityTimelock < 12_960 || values.fidelityTimelock > 25_920) {
    return "Fidelity timelock must be between 12,960 and 25,920 blocks.";
  }
  return { ...settings, ...values };
}

function SettingsSection({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <Card className="border-line-strong"><div className="border-b border-line px-5 py-4"><h2 className="font-header text-[14px] font-bold">{title}</h2><p className="mt-1 text-[11px] text-muted">{subtitle}</p></div><div className="grid grid-cols-2 gap-4 p-5 max-[620px]:grid-cols-1">{children}</div></Card>;
}

function SettingsPanel({ settings, makerId, editable, onSaved }: { settings: MakerSettings; makerId: string; editable: boolean; onSaved: () => Promise<void> }) {
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);
  const [form, setForm] = useState<SettingsForm>(() => settingsToForm(settings));
  const [saving, setSaving] = useState(false);
  const [confirmPortChange, setConfirmPortChange] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setForm(settingsToForm(settings)), [makerId]);

  const parsed = parseSettingsForm(settings, form);
  const error = typeof parsed === "string" ? parsed : null;
  const dirty = EDITABLE_SETTING_KEYS.some((key) => form[key] !== String(settings[key]));
  const field = (key: EditableSettingKey) => ({
    value: form[key],
    disabled: !editable || saving,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value })),
  });

  async function save(next: MakerSettings) {
    setSaving(true);
    try {
      const saved = await updateMakerSettings(makerId, next);
      setForm(settingsToForm(saved));
      setConfirmPortChange(false);
      await onSaved();
      pushToast("success", "Maker settings saved. They will apply on the next start.");
    } catch (e) {
      pushToast("error", (e as { message?: string }).message ?? "Could not save maker settings.");
    } finally {
      setSaving(false);
    }
  }

  function requestSave() {
    if (typeof parsed === "string" || !editable) return;
    if (parsed.networkPort !== settings.networkPort) setConfirmPortChange(true);
    else void save(parsed);
  }

  return <div className="space-y-4">
    {!editable && <div className="rounded-control border border-warning/35 bg-warning/[0.08] px-4 py-3 text-[12px] text-warning">Stop the maker before editing settings. Runtime configuration is fixed while the server is active.</div>}
    <Card className="border-line-strong p-5"><div className="grid grid-cols-3 gap-4 max-[760px]:grid-cols-1">{[["Maker ID", settings.makerId], ["Wallet", settings.walletName], ["Data directory", settings.dataDir ?? "Default"]].map(([label, value]) => <div key={label} className="min-w-0"><span className="font-mono text-[9px] uppercase tracking-widest text-subtle">{label}</span><strong className="mt-1.5 block truncate font-mono text-[11px]" title={value}>{value}</strong></div>)}</div><p className="mt-4 border-t border-line pt-3 text-[11px] text-muted">Maker identity and wallet location are fixed to prevent accidentally switching this registration to another wallet.</p></Card>
    <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
      <SettingsSection title="Network" subtitle="Inbound maker and local RPC listeners">
        <TextField label="Network port" inputMode="numeric" hint="Do not change for a fidelity-bonded maker." {...field("networkPort")} />
        <TextField label="RPC port" inputMode="numeric" {...field("rpcPort")} />
        <div className="col-span-2 max-[620px]:col-span-1"><TextField label="Required confirmations" inputMode="numeric" {...field("requiredConfirms")} /></div>
      </SettingsSection>
      <SettingsSection title="Tor" subtitle="Shared Tor SOCKS and control service">
        <TextField label="SOCKS port" inputMode="numeric" {...field("socksPort")} />
        <TextField label="Control port" inputMode="numeric" {...field("controlPort")} />
      </SettingsSection>
      <SettingsSection title="Swap policy" subtitle="Minimum size and advertised maker fees">
        <TextField label="Minimum swap amount (sats)" inputMode="numeric" {...field("minSwapAmount")} />
        <TextField label="Base fee (sats)" inputMode="numeric" {...field("baseFee")} />
        <TextField label="Amount-relative fee (%)" inputMode="decimal" {...field("amountRelativeFeePct")} />
        <TextField label="Time-relative fee (%)" inputMode="decimal" {...field("timeRelativeFeePct")} />
      </SettingsSection>
      <SettingsSection title="Fidelity" subtitle="Defaults used when creating future fidelity bonds">
        <TextField label="Target amount (sats)" inputMode="numeric" {...field("fidelityAmount")} />
        <TextField label="Timelock (blocks)" inputMode="numeric" {...field("fidelityTimelock")} />
      </SettingsSection>
    </div>
    <Card className="border-line-strong p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-header text-[14px] font-bold">Save configuration</h2><p className={`mt-1 text-[11.5px] ${error ? "text-danger" : "text-muted"}`}>{error ?? (dirty ? "Unsaved changes will apply the next time this maker starts." : "Configuration is up to date.")}</p></div><div className="flex gap-2"><Button variant="secondary" disabled={!dirty || saving} onClick={() => setForm(settingsToForm(settings))}>Discard</Button><Button disabled={!editable || !dirty || !!error} loading={saving} onClick={requestSave}><Save size={14} />Save changes</Button></div></div></Card>
    <Card className="border-danger/30 p-5"><div className="flex items-center justify-between gap-4"><div><h2 className="font-header text-[14px] font-bold text-danger">Remove registration</h2><p className="mt-1 text-[11.5px] text-muted">Forgets this stopped maker. Wallet files and on-chain funds are not deleted.</p></div><Button variant="secondary" disabled={!editable} onClick={() => setConfirmRemove(true)}><Trash2 size={14} />Remove</Button></div></Card>
    {confirmPortChange && typeof parsed !== "string" && <Modal title="Change fidelity-bound network port?" onClose={() => setConfirmPortChange(false)} footer={<><Button variant="secondary" onClick={() => setConfirmPortChange(false)}>Cancel</Button><Button onClick={() => void save(parsed)} loading={saving}>Change port and save</Button></>}><div className="flex gap-3 text-[12px] leading-5 text-muted"><AlertTriangle className="mt-0.5 shrink-0 text-warning" size={18} /><p>A fidelity bond commits to the maker address using network port <strong className="text-foreground">{settings.networkPort}</strong>. Changing it to <strong className="text-foreground">{parsed.networkPort}</strong> can make an existing bond unusable for this maker. Only continue if this maker has no active fidelity bond or you understand the migration.</p></div></Modal>}
    {confirmRemove && <Modal title="Remove maker registration?" onClose={() => setConfirmRemove(false)} footer={<><Button variant="secondary" onClick={() => setConfirmRemove(false)}>Cancel</Button><Button onClick={() => void clearMakerSettings(makerId).then(() => { pushToast("success", `${makerId} was removed.`); navigate("/maker"); }).catch((e) => pushToast("error", e.message))}>Remove registration</Button></>}><p className="text-[12px] leading-5 text-muted">This removes <strong className="text-foreground">{makerId}</strong> from the app. It does not delete the maker wallet or change blockchain state.</p></Modal>}
  </div>;
}

export function MakerWorkspacePage() {
  const { makerId = "" } = useParams(); const id = decodeURIComponent(makerId); const pushToast = useToastStore((s) => s.push); const [searchParams, setSearchParams] = useSearchParams(); const requestedTab = searchParams.get("tab") as Tab | null; const tab = TAB_OPTIONS.some((item) => item.value === requestedTab) ? requestedTab! : "overview";
  const [status, setStatus] = useState<MakerStatus | null>(null); const [settings, setSettings] = useState<MakerSettings | null>(null); const [info, setInfo] = useState<WalletInfo | null>(null); const [balances, setBalances] = useState<Balances | null>(null); const [bonds, setBonds] = useState<FidelityBond[]>([]); const [reports, setReports] = useState<MakerSwapReportSummary[]>([]); const [loading, setLoading] = useState(true); const [actionLoading, setActionLoading] = useState(false); const [showStart, setShowStart] = useState(false); const [walletPassword, setWalletPassword] = useState(""); const [torPassword, setTorPassword] = useState(""); const [copied, setCopied] = useState(false);
  const load = useCallback(async () => { const [nextStatus, nextSettings, nextInfo] = await Promise.all([getMakerStatus(id), getSavedMakerSettings(id), getMakerInfo(id)]); if (!nextSettings) throw new Error("Maker registration was not found."); setStatus(nextStatus); setSettings(nextSettings); setInfo(nextInfo); const [b, f, r] = await Promise.allSettled([getMakerBalances(id), listMakerFidelityBonds(id), listMakerSwapReports(id)]); setBalances(b.status === "fulfilled" ? b.value : null); setBonds(f.status === "fulfilled" ? f.value : []); setReports(r.status === "fulfilled" ? r.value : []); setLoading(false); }, [id]);
  useEffect(() => { void load().catch((e) => { pushToast("error", e.message); setLoading(false); }); const timer = setInterval(() => void load().catch(() => {}), 5000); return () => clearInterval(timer); }, [load, pushToast]);
  const phase = status?.phase.phase ?? "notConfigured"; const running = phase === "running" || phase === "starting"; const transitioning = ["initializing", "starting", "stopping"].includes(phase); const settingsEditable = phase === "stopped" || phase === "failed";
  async function start() { setActionLoading(true); try { await startMaker(id, walletPassword || undefined, torPassword || undefined); setShowStart(false); setWalletPassword(""); setTorPassword(""); await load(); } catch (e) { pushToast("error", (e as { message?: string }).message ?? "Could not start maker."); } finally { setActionLoading(false); } }
  async function stop() { setActionLoading(true); try { await stopMaker(id); await load(); } catch (e) { pushToast("error", (e as { message?: string }).message ?? "Could not stop maker."); } finally { setActionLoading(false); } }
  if (loading || !status || !settings || !info) return <div className="grid h-full place-items-center"><RefreshCw className="animate-spin text-primary" /></div>;
  const tor = status.torAddress;
  return <div className="h-full overflow-y-auto p-8"><div className="mx-auto w-full max-w-[1380px] pb-8"><header className="flex flex-wrap items-center justify-between gap-4"><div className="flex min-w-0 items-center gap-3"><Link to="/maker" className="grid h-9 w-9 place-items-center rounded-control border border-line text-muted hover:text-foreground"><ArrowLeft size={16} /></Link><div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate font-header text-[27px] font-bold">{id}</h1><span className={`h-2 w-2 rounded-full ${phase === "running" ? "bg-success" : phase === "failed" ? "bg-danger" : transitioning ? "bg-warning" : "bg-subtle"}`} /></div><button type="button" disabled={!tor} onClick={() => tor && navigator.clipboard.writeText(tor).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })} className="mt-1 flex max-w-full items-center gap-2 text-left font-mono text-[10.5px] text-subtle disabled:cursor-default"><span className="truncate">{tor ? formatTorEndpoint(tor, 24, 14, true) : `Status · ${phase}`}</span>{tor && <Copy size={12} className={copied ? "text-success" : ""} />}</button></div></div><div className="flex gap-2"><Button variant="secondary" onClick={() => void load()}><RefreshCw size={14} />Refresh</Button>{running ? <Button onClick={() => void stop()} loading={actionLoading} disabled={transitioning}><Square size={13} />Stop maker</Button> : <Button onClick={() => setShowStart(true)} disabled={transitioning}><Play size={13} />Start maker</Button>}</div></header>
    {phase === "failed" && status.phase.phase === "failed" && <div className="mt-4 rounded-control border border-danger/35 bg-danger/[0.08] px-4 py-3 text-[12px] text-danger">{status.phase.message}</div>}
    <div className="mt-6 border-b border-line"><SegmentedToggle groupId="maker-workspace-tabs" value={tab} onChange={(value) => setSearchParams(value === "overview" ? {} : { tab: value })} options={TAB_OPTIONS} /></div>
    <main className="mt-5">{tab === "overview" && <OverviewPanel status={status} settings={settings} info={info} balances={balances} bonds={bonds} reports={reports} />}{tab === "wallet" && <WalletPanel makerId={id} running={running} />}{tab === "logs" && <LogsPanel makerId={id} />}{tab === "settings" && <SettingsPanel settings={settings} makerId={id} editable={settingsEditable} onSaved={load} />}</main>
    {showStart && <Modal title={`Start ${id}`} onClose={() => setShowStart(false)} footer={<><Button variant="secondary" onClick={() => setShowStart(false)}>Cancel</Button><Button onClick={() => void start()} loading={actionLoading}>Start maker</Button></>}><p className="text-[12px] text-muted">Passwords stay in memory for this process and are not saved with the registration.</p><PasswordField label="Wallet password (if encrypted)" value={walletPassword} onChange={(e) => setWalletPassword(e.target.value)} /><PasswordField label="Tor control password (if required)" value={torPassword} onChange={(e) => setTorPassword(e.target.value)} /></Modal>}
  </div></div>;
}
