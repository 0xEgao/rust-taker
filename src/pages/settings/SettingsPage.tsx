import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  ScrollText,
  Save,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  backupWallet,
  checkBackend,
  checkPort,
  checkTor,
  getChainBackend,
  resetChainBackend,
  setChainBackend,
  shutdownTaker,
} from "../../api/commands";
import type {
  BackendStatus,
  ChainBackendConfig,
  ChainBackendKind,
  ElectrumBackend,
  NodeBackend,
} from "../../api/types";
import { Modal } from "../../components/ui/display";
import { Button, PasswordField, SegmentedToggle, TextField } from "../../components/ui/inputs";
import {
  HARDCODED_DEFAULTS,
  RPC_HOST,
  loadConnectivityDefaults,
  saveConnectivityDefaults,
  type ConnectivityConfig,
} from "../../lib/connectivity";
import { useSessionStore } from "../../store/session";
import { useToastStore } from "../../store/toast";

const BITCOIN_GUIDE_URL = "https://github.com/citadel-tech/coinswap/blob/master/docs/bitcoind.md";

const DEFAULT_NODE: NodeBackend = {
  host: RPC_HOST,
  port: 38332,
  username: "user",
  password: "password",
  zmqPort: 28332,
};

// Only the *active* backend's settings force a wallet reload — editing the idle
// section changes nothing about the connection the running taker already holds.
function activeFingerprint(kind: ChainBackendKind, electrum: ElectrumBackend, node: NodeBackend) {
  return kind === "electrum"
    ? `electrum|${electrum.url}|${electrum.useTor}`
    : `node|${node.host}|${node.port}|${node.username}|${node.password}|${node.zmqPort}`;
}

interface TestRow {
  label: string;
  ok: boolean;
  message: string;
}

function TestResultRows({ rows }: { rows: TestRow[] }) {
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-raised px-3 py-2 text-[12px]">
          <span className={`flex items-center gap-1.5 font-medium ${r.ok ? "text-success" : "text-danger"}`}>
            {r.ok ? <CheckCircle2 size={13} strokeWidth={2} /> : <XCircle size={13} strokeWidth={2} />}
            {r.label}
          </span>
          <span className="truncate text-subtle">{r.message}</span>
        </div>
      ))}
    </div>
  );
}

function SectionDot({ color = "bg-primary" }: { color?: string }) {
  return <span className={`h-1.5 w-1.5 rounded-full ${color}`} />;
}

function ActiveBadge({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-widest text-primary">
      In use
    </span>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);
  const resetSession = useSessionStore((s) => s.reset);

  const [tor, setTor] = useState<ConnectivityConfig>(loadConnectivityDefaults);
  const [torPasswordVisible, setTorPasswordVisible] = useState(false);

  const [kind, setKind] = useState<ChainBackendKind>("electrum");
  const [electrum, setElectrum] = useState<ElectrumBackend>({ url: "", useTor: false });
  const [node, setNode] = useState<NodeBackend>(DEFAULT_NODE);
  const [nodeAdded, setNodeAdded] = useState(false);
  // Captured once, from the config the running taker was built against.
  const [bootFingerprint, setBootFingerprint] = useState<string | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);

  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [testingElectrum, setTestingElectrum] = useState(false);
  const [electrumRows, setElectrumRows] = useState<TestRow[] | null>(null);
  const [testingNode, setTestingNode] = useState(false);
  const [nodeRows, setNodeRows] = useState<TestRow[] | null>(null);
  const [testingTor, setTestingTor] = useState(false);
  const [torRows, setTorRows] = useState<TestRow[] | null>(null);

  const [backupOpen, setBackupOpen] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupConfirm, setBackupConfirm] = useState("");
  const [backupError, setBackupError] = useState<string | undefined>();
  const [backingUp, setBackingUp] = useState(false);

  const [confirmReset, setConfirmReset] = useState(false);
  const [copied, setCopied] = useState(false);

  // An onion server has no route without a proxy, so the toggle is not the user's to make there.
  const onionUrl = electrum.url.includes(".onion");
  const electrumRoute = electrum.useTor || onionUrl ? "tor" : "direct";
  const needsReload = savedFingerprint !== null && savedFingerprint !== bootFingerprint;

  useEffect(() => {
    void getChainBackend()
      .then((c) => {
        applyConfig(c);
        const fp = activeFingerprint(c.kind, c.electrum, c.node ?? DEFAULT_NODE);
        setBootFingerprint(fp);
        setSavedFingerprint(fp);
        return checkBackend(undefined, loadConnectivityDefaults().torSocksPort);
      })
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  function applyConfig(c: ChainBackendConfig) {
    setKind(c.kind);
    setElectrum(c.electrum);
    setNodeAdded(c.node !== null);
    if (c.node) setNode(c.node);
  }

  async function persistBackend(nextKind: ChainBackendKind, addNode: boolean) {
    const config: ChainBackendConfig = {
      kind: nextKind,
      electrum: { ...electrum, useTor: electrum.useTor || onionUrl },
      node: addNode || nodeAdded ? node : null,
    };
    try {
      await setChainBackend(config);
    } catch (e) {
      pushToast("error", (e as { message?: string })?.message ?? "Could not save the connection.");
      return;
    }
    applyConfig(config);
    setSavedFingerprint(activeFingerprint(config.kind, config.electrum, config.node ?? DEFAULT_NODE));
    saveConnectivityDefaults(tor);
    pushToast("success", "Settings saved.");
    setStatus(await checkBackend(config, tor.torSocksPort).catch(() => null));
  }

  function describe(result: PromiseSettledResult<BackendStatus>): TestRow {
    if (result.status === "rejected") {
      return { label: "Connection", ok: false, message: (result.reason as { message?: string })?.message ?? "Unreachable" };
    }
    const s = result.value;
    return {
      label: "Connection",
      ok: s.reachable,
      message: s.reachable
        ? [s.subversion, s.chain, s.blocks !== undefined ? `${s.blocks.toLocaleString()} blocks` : null]
            .filter(Boolean)
            .join(" · ")
        : (s.error ?? "Unreachable"),
    };
  }

  async function testElectrum() {
    setTestingElectrum(true);
    const config: ChainBackendConfig = {
      kind: "electrum",
      electrum: { ...electrum, useTor: electrum.useTor || onionUrl },
      node: nodeAdded ? node : null,
    };
    const [result] = await Promise.allSettled([checkBackend(config, tor.torSocksPort)]);
    setElectrumRows([describe(result)]);
    setTestingElectrum(false);
  }

  async function testNode() {
    setTestingNode(true);
    const config: ChainBackendConfig = { kind: "coreRpc", electrum, node };
    const [rpcResult, zmqResult] = await Promise.allSettled([
      checkBackend(config, tor.torSocksPort),
      checkPort(node.host, node.zmqPort),
    ]);
    setNodeRows([
      { ...describe(rpcResult), label: "RPC" },
      {
        label: "ZMQ",
        ok: zmqResult.status === "fulfilled" && zmqResult.value.reachable,
        message:
          zmqResult.status === "fulfilled"
            ? zmqResult.value.reachable
              ? `Port ${node.zmqPort} reachable`
              : (zmqResult.value.error ?? "Unreachable")
            : "Unreachable",
      },
    ]);
    setTestingNode(false);
  }

  async function testTor() {
    setTestingTor(true);
    // checkTor ensures Tor is actually running (system/host-binary/embedded fallback) before
    // its handshake — run it first so the SOCKS-port check below reflects that, not a race.
    const [torResult] = await Promise.allSettled([checkTor(tor.torSocksPort, tor.torControlPort, tor.torAuthPassword)]);
    const [socksResult] = await Promise.allSettled([checkPort(RPC_HOST, tor.torSocksPort)]);
    setTorRows([
      {
        label: "SOCKS Port",
        ok: socksResult.status === "fulfilled" && socksResult.value.reachable,
        message:
          socksResult.status === "fulfilled"
            ? socksResult.value.reachable
              ? `Port ${tor.torSocksPort} reachable`
              : (socksResult.value.error ?? "Unreachable")
            : "Unreachable",
      },
      {
        label: "Control Port",
        ok: torResult.status === "fulfilled" && torResult.value.reachable && torResult.value.authenticated,
        message:
          torResult.status === "fulfilled"
            ? (torResult.value.error ?? (torResult.value.authenticated ? "Authenticated" : "Reachable"))
            : "Unreachable",
      },
    ]);
    setTestingTor(false);
  }

  async function handleResetConfirmed() {
    setTor(HARDCODED_DEFAULTS);
    saveConnectivityDefaults(HARDCODED_DEFAULTS);
    setConfirmReset(false);
    setElectrumRows(null);
    setNodeRows(null);
    setTorRows(null);
    try {
      const defaults = await resetChainBackend();
      applyConfig(defaults);
      setNode(DEFAULT_NODE);
      setSavedFingerprint(activeFingerprint(defaults.kind, defaults.electrum, DEFAULT_NODE));
      pushToast("success", "Settings reset to defaults.");
    } catch (e) {
      pushToast("error", (e as { message?: string })?.message ?? "Could not reset the connection.");
    }
  }

  async function lockAndReload() {
    try {
      await shutdownTaker();
    } catch {
      // Already gone, or a swap holds the lock — either way the session must reset.
    }
    resetSession();
  }

  async function copyZmqConfig() {
    const text = `zmqpubrawblock=tcp://127.0.0.1:${node.zmqPort}\nzmqpubrawtx=tcp://127.0.0.1:${node.zmqPort}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      pushToast("error", "Could not copy to clipboard.");
    }
  }

  function submitBackup() {
    setBackupError(undefined);
    if (!backupPassword) return setBackupError("Please enter a backup password.");
    if (backupPassword.length < 8) return setBackupError("Password must be at least 8 characters.");
    if (backupPassword !== backupConfirm) return setBackupError("Passwords do not match.");
    void performBackup(backupPassword);
  }

  async function performBackup(password: string) {
    const destinationPath = await save({
      defaultPath: `coinswap-wallet-backup-${new Date().toISOString().split("T")[0]}.json`,
      filters: [{ name: "JSON Files", extensions: ["json"] }],
    });
    if (!destinationPath) return;

    setBackingUp(true);
    try {
      await backupWallet(destinationPath, password);
      pushToast("success", `Backup created at ${destinationPath}`);
      setBackupOpen(false);
      setBackupPassword("");
      setBackupConfirm("");
    } catch (e) {
      pushToast("error", `Backup failed: ${(e as { message?: string })?.message ?? "unknown error"}`);
    } finally {
      setBackingUp(false);
    }
  }

  return (
    <div className="p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[34px] font-bold leading-none tracking-tight text-foreground">Settings</h1>
          <p className="mt-2 font-mono text-[10.5px] uppercase tracking-widest text-subtle">Wallet &amp; Network</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => setConfirmReset(true)}>
            Reset to Defaults
          </Button>
          <Button onClick={() => void persistBackend(kind, false)}>
            <Save size={14} strokeWidth={2} /> Save Settings
          </Button>
        </div>
      </header>

      {needsReload && (
        <div className="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-warning/40 bg-warning/10 px-5 py-4">
          <p className="text-[12.5px] text-muted">
            The chain connection changed. This wallet is still running on the previous one — reload it to switch over.
          </p>
          <Button size="sm" variant="secondary" onClick={() => void lockAndReload()}>
            <Lock size={13} strokeWidth={2} /> Lock &amp; reload wallet
          </Button>
        </div>
      )}

      <div className="mt-6 flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
        {/* Wallet backup */}
        <section className="p-6">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-subtle">
            <SectionDot color="bg-warning" />
            Wallet Backup
          </div>
          <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-muted">
            Export your wallet to an encrypted backup file. This is useful for recovering the wallet or migrating it
            to other Coinswap clients.
          </p>
          <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-relaxed text-subtle">
            <li>Wallet Backup is an encrypted JSON file that contains all wallet data and swap histories.</li>
            <li>Use it to recover this wallet or migrate it to another Coinswap client.</li>
            <li>Recommended to use a strong password for the backup file.</li>
            <li>Use the same password while restoring wallet from backup.</li>
          </ul>

          {!backupOpen ? (
            <Button className="mt-4 w-full justify-center" onClick={() => setBackupOpen(true)}>
              <Save size={15} strokeWidth={2} /> Create Backup
            </Button>
          ) : (
            <div className="mt-4">
              <div className="grid grid-cols-2 gap-3">
                <PasswordField
                  label="Backup Password"
                  placeholder="Enter password"
                  value={backupPassword}
                  onChange={(e) => setBackupPassword(e.target.value)}
                />
                <PasswordField
                  label="Confirm Password"
                  placeholder="Re-enter password"
                  value={backupConfirm}
                  onChange={(e) => setBackupConfirm(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitBackup()}
                />
              </div>
              {backupError && <p className="mt-2 text-[12px] text-danger">{backupError}</p>}
              <Button className="mt-3 w-full justify-center" onClick={submitBackup} loading={backingUp}>
                <Check size={14} strokeWidth={2} /> Confirm &amp; Create Backup
              </Button>
            </div>
          )}
        </section>

        {/* Connection status */}
        <section className="p-6">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-subtle">
            <span className={`h-1.5 w-1.5 rounded-full ${status?.reachable ? "bg-success" : "bg-subtle/40"}`} />
            Connection Status
            <span className={`ml-1 font-semibold ${status?.reachable ? "text-success" : "text-danger"}`}>
              {status?.reachable ? "Connected" : "Not Connected"}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-3">
            {[
              ["Source", kind === "coreRpc" ? "Your node" : "Electrum"],
              ["Network", status?.chain ?? "--"],
              ["Block Height", status?.blocks !== undefined ? status.blocks.toLocaleString() : "--"],
              [
                "Sync Progress",
                status?.verificationProgress !== undefined
                  ? `${(status.verificationProgress * 100).toFixed(1)}%`
                  : "--",
              ],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-line bg-surface-raised px-3.5 py-3">
                <span className="block text-[11px] text-subtle">{label}</span>
                <strong className="mt-1 block font-mono text-[13px] text-foreground">{value}</strong>
              </div>
            ))}
          </div>
        </section>

        {/* Electrum server */}
        <section className="p-6">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-subtle">
            <SectionDot />
            Electrum Server
            <ActiveBadge active={kind === "electrum"} />
          </div>
          <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-muted">
            The wallet reads the chain from this server. Connecting directly is faster and far more reliable, but the
            server sees your IP address. Routing through Tor hides it, at the cost of speed — a circuit that stalls or
            drops mid-swap can hold up the swap, so only choose it if the privacy is worth that risk to you.
          </p>
          <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-3">
            <TextField
              label="Server URL"
              placeholder="tcp://host:50001"
              value={electrum.url}
              onChange={(e) => setElectrum((c) => ({ ...c, url: e.target.value }))}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-muted">Route</label>
              <SegmentedToggle
                groupId="electrum-route"
                value={electrumRoute}
                onChange={(v) => setElectrum((c) => ({ ...c, useTor: v === "tor" }))}
                options={[
                  {
                    value: "direct",
                    label: "Direct",
                    disabled: onionUrl,
                    title: onionUrl ? "An onion address can only be reached over Tor" : undefined,
                  },
                  { value: "tor", label: "Via Tor" },
                ]}
              />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => void testElectrum()} loading={testingElectrum}>
              Test connection
            </Button>
            {kind !== "electrum" && (
              <Button size="sm" onClick={() => void persistBackend("electrum", false)}>
                Use Electrum
              </Button>
            )}
          </div>
          {electrumRows && <TestResultRows rows={electrumRows} />}
        </section>

        {/* Own node */}
        <section className="p-6">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-subtle">
            <SectionDot color="bg-success" />
            Add Your Own Node
            <ActiveBadge active={kind === "coreRpc"} />
          </div>
          <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-muted">
            Skip the Electrum server entirely and talk to a Bitcoin Core node you run. It needs RPC credentials and
            ZMQ notifications enabled.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-6">
            <div>
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="RPC Host"
                  value={node.host}
                  onChange={(e) => setNode((c) => ({ ...c, host: e.target.value }))}
                />
                <TextField
                  label="RPC Port"
                  type="text"
                  inputMode="numeric"
                  value={node.port}
                  onChange={(e) => setNode((c) => ({ ...c, port: Number(e.target.value) || 0 }))}
                />
                <TextField
                  label="RPC Username"
                  value={node.username}
                  onChange={(e) => setNode((c) => ({ ...c, username: e.target.value }))}
                />
                <PasswordField
                  label="RPC Password"
                  placeholder="Enter RPC password"
                  value={node.password}
                  onChange={(e) => setNode((c) => ({ ...c, password: e.target.value }))}
                />
              </div>
              <div className="mt-3">
                <TextField
                  label="ZMQ Port"
                  type="text"
                  inputMode="numeric"
                  value={node.zmqPort}
                  onChange={(e) => setNode((c) => ({ ...c, zmqPort: Number(e.target.value) || 0 }))}
                />
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Button size="sm" variant="secondary" onClick={() => void testNode()} loading={testingNode}>
                  Test connection
                </Button>
                <Button size="sm" onClick={() => void persistBackend("coreRpc", true)}>
                  {kind === "coreRpc" ? "Save node" : "Use this node"}
                </Button>
              </div>
              {nodeRows && <TestResultRows rows={nodeRows} />}
            </div>

            <div>
              <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-widest text-subtle">
                bitcoin.conf snippet
                <span className="text-subtle">Read-only</span>
              </div>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-surface-raised p-3 font-mono text-[12px] text-muted">
                {`zmqpubrawblock=tcp://127.0.0.1:${node.zmqPort}\nzmqpubrawtx=tcp://127.0.0.1:${node.zmqPort}`}
              </pre>
              <Button variant="secondary" size="sm" className="mt-2.5 w-full justify-center" onClick={() => void copyZmqConfig()}>
                {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
                {copied ? "Copied!" : "Copy ZMQ Config"}
              </Button>
              <button
                type="button"
                onClick={() => void openUrl(BITCOIN_GUIDE_URL)}
                className="mt-2.5 flex w-full items-center justify-between rounded-lg border border-line px-3 py-2.5 text-[12.5px] text-primary transition-colors hover:border-line-strong hover:text-primary-hover"
              >
                <span className="flex items-center gap-1.5">
                  <ExternalLink size={14} strokeWidth={2} /> Bitcoin Core setup guide
                </span>
                <span className="font-mono text-[10.5px] uppercase tracking-widest text-subtle">coinswap docs →</span>
              </button>
            </div>
          </div>
        </section>

        {/* Tor */}
        <section className="p-6">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-subtle">
            <SectionDot color="bg-[#b990ff]" />
            Tor
          </div>
          <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-muted">
            Swaps always run over Tor — makers are reachable only as hidden services. These ports are used for that,
            and for the Electrum server when it is set to route via Tor.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <TextField
              label="Control Port"
              type="text"
              inputMode="numeric"
              value={tor.torControlPort}
              onChange={(e) => setTor((c) => ({ ...c, torControlPort: Number(e.target.value) || 0 }))}
            />
            <TextField
              label="SOCKS Port"
              type="text"
              inputMode="numeric"
              value={tor.torSocksPort}
              onChange={(e) => setTor((c) => ({ ...c, torSocksPort: Number(e.target.value) || 0 }))}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-muted">Auth Password</label>
              <div className="relative">
                <input
                  type={torPasswordVisible ? "text" : "password"}
                  placeholder="Optional"
                  value={tor.torAuthPassword}
                  onChange={(e) => setTor((c) => ({ ...c, torAuthPassword: e.target.value }))}
                  className="h-10 w-full rounded-sm border border-line bg-surface-raised px-3 pr-10 text-[13px] text-foreground outline-none transition-colors placeholder:text-subtle focus:border-line-strong"
                />
                <button
                  type="button"
                  onClick={() => setTorPasswordVisible((v) => !v)}
                  aria-label={torPasswordVisible ? "Hide password" : "Show password"}
                  className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-subtle hover:text-muted"
                >
                  {torPasswordVisible ? <EyeOff size={16} strokeWidth={1.6} /> : <Eye size={16} strokeWidth={1.6} />}
                </button>
              </div>
            </div>
          </div>
          <div className="mt-4">
            <Button size="sm" variant="secondary" onClick={() => void testTor()} loading={testingTor}>
              Test Tor
            </Button>
          </div>
          {torRows && <TestResultRows rows={torRows} />}
        </section>

        <section className="p-6">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-subtle">
            <SectionDot color="bg-subtle" />
            Logs
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[12.5px] text-muted">View the tail of this session's debug log.</p>
            <Button size="sm" variant="secondary" onClick={() => navigate("/logs")}>
              <ScrollText size={14} strokeWidth={2} />
              View Logs
            </Button>
          </div>
        </section>
      </div>

      {confirmReset && (
        <Modal
          title="Reset all settings?"
          onClose={() => setConfirmReset(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleResetConfirmed()}>Reset</Button>
            </>
          }
        >
          <p className="text-[13px] text-muted">
            This restores the bundled Electrum server, forgets the node you added, and resets Tor ports back to their
            defaults. It does not affect your wallet or funds.
          </p>
        </Modal>
      )}
    </div>
  );
}
