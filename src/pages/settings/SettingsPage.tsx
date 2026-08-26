import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
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
  checkCoreZmq,
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
import {
  Card,
  Modal,
  SettingsSection,
} from "../../components/ui/display";
import {
  Button,
  PasswordField,
  SegmentedToggle,
  SummaryGroup,
  SummaryRow,
  TextField,
} from "../../components/ui/inputs";
import {
  HARDCODED_DEFAULTS,
  RPC_HOST,
  loadConnectivityDefaults,
  saveConnectivityDefaults,
  type ConnectivityConfig,
} from "../../lib/connectivity";
import { useSessionStore } from "../../store/session";
import { useWalletCacheStore } from "../../store/wallet-cache";
import { useToastStore } from "../../store/toast";

const BITCOIN_GUIDE_URL =
  "https://github.com/citadel-tech/coinswap/blob/master/docs/bitcoind.md";

const DEFAULT_NODE: NodeBackend = {
  host: RPC_HOST,
  port: 38332,
  username: "user",
  password: "password",
  passwordConfigured: false,
  zmqPort: 28332,
};

// Only the *active* backend's settings force a wallet reload — editing the idle
// section changes nothing about the connection the running taker already holds.
function activeFingerprint(
  kind: ChainBackendKind,
  electrum: ElectrumBackend,
  node: NodeBackend,
) {
  return kind === "electrum"
    ? `electrum|${electrum.url}|${electrum.useTor}`
    : `node|${node.host}|${node.port}|${node.username}|${node.zmqPort}`;
}

function connectivityFingerprint(config: ConnectivityConfig) {
  return `${config.torSocksPort}|${config.torControlPort}|${config.torAuthPassword}`;
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
        <div
          key={r.label}
          className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface-raised px-3 py-2 text-[12px]"
        >
          <span
            className={`flex items-center gap-1.5 font-medium ${r.ok ? "text-success" : "text-danger"}`}
          >
            {r.ok ? (
              <CheckCircle2 size={13} strokeWidth={2} />
            ) : (
              <XCircle size={13} strokeWidth={2} />
            )}
            {r.label}
          </span>
          <span className="truncate text-subtle">{r.message}</span>
        </div>
      ))}
    </div>
  );
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
  const resetWalletCache = useWalletCacheStore((s) => s.reset);
  // Reachable from a maker-only session for the shared chain/Tor config, so anything that
  // acts on the taker's wallet has nothing to act on and is hidden.
  const takerUnlocked = useSessionStore((s) => s.initialized);

  const [tor, setTor] = useState<ConnectivityConfig>(loadConnectivityDefaults);
  const [savedTorFingerprint, setSavedTorFingerprint] = useState(() =>
    connectivityFingerprint(loadConnectivityDefaults()),
  );

  const [kind, setKind] = useState<ChainBackendKind>("electrum");
  const [electrum, setElectrum] = useState<ElectrumBackend>({
    url: "",
    useTor: false,
  });
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
  const needsReload =
    savedFingerprint !== null && savedFingerprint !== bootFingerprint;
  const settingsDirty =
    savedFingerprint !== null &&
    (activeFingerprint(kind, electrum, node) !== savedFingerprint ||
      connectivityFingerprint(tor) !== savedTorFingerprint);

  useEffect(() => {
    void getChainBackend()
      .then((c) => {
        applyConfig(c);
        const fp = activeFingerprint(
          c.kind,
          c.electrum,
          c.node ?? DEFAULT_NODE,
        );
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
    if (c.node) setNode({ ...c.node, password: "" });
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
      pushToast(
        "error",
        (e as { message?: string })?.message ??
          "Could not save the connection.",
      );
      return;
    }
    applyConfig({
      ...config,
      node: config.node ? { ...config.node, password: "", passwordConfigured: true } : null,
    });
    setSavedFingerprint(
      activeFingerprint(
        config.kind,
        config.electrum,
        config.node ?? DEFAULT_NODE,
      ),
    );
    saveConnectivityDefaults(tor);
    setSavedTorFingerprint(connectivityFingerprint(tor));
    pushToast("success", "Settings saved.");
    setStatus(await checkBackend(config, tor.torSocksPort).catch(() => null));
  }

  function describe(result: PromiseSettledResult<BackendStatus>): TestRow {
    if (result.status === "rejected") {
      return {
        label: "Connection",
        ok: false,
        message:
          (result.reason as { message?: string })?.message ?? "Unreachable",
      };
    }
    const s = result.value;
    return {
      label: "Connection",
      ok: s.reachable,
      message: s.reachable
        ? [
            s.subversion,
            s.chain,
            s.blocks !== undefined
              ? `${s.blocks.toLocaleString()} blocks`
              : null,
          ]
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
    const [result] = await Promise.allSettled([
      checkBackend(config, tor.torSocksPort),
    ]);
    setElectrumRows([describe(result)]);
    setTestingElectrum(false);
  }

  async function testNode() {
    setTestingNode(true);
    const config: ChainBackendConfig = { kind: "coreRpc", electrum, node };
    const [rpcResult, zmqResult] = await Promise.allSettled([
      checkBackend(config, tor.torSocksPort),
      checkCoreZmq(node.host, node.zmqPort),
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
    const [torResult] = await Promise.allSettled([
      checkTor(tor.torSocksPort, tor.torControlPort, tor.torAuthPassword),
    ]);
    setTorRows([
      {
        label: "SOCKS Port",
        ok: torResult.status === "fulfilled" && torResult.value.reachable,
        message:
          torResult.status === "fulfilled"
            ? torResult.value.reachable
              ? `Port ${tor.torSocksPort} reachable`
              : (torResult.value.error ?? "Unreachable")
            : "Unreachable",
      },
      {
        label: "Control Port",
        ok:
          torResult.status === "fulfilled" &&
          torResult.value.reachable &&
          torResult.value.authenticated,
        message:
          torResult.status === "fulfilled"
            ? (torResult.value.error ??
              (torResult.value.authenticated ? "Authenticated" : "Reachable"))
            : "Unreachable",
      },
    ]);
    setTestingTor(false);
  }

  async function handleResetConfirmed() {
    setTor(HARDCODED_DEFAULTS);
    saveConnectivityDefaults(HARDCODED_DEFAULTS);
    setSavedTorFingerprint(connectivityFingerprint(HARDCODED_DEFAULTS));
    setConfirmReset(false);
    setElectrumRows(null);
    setNodeRows(null);
    setTorRows(null);
    try {
      const defaults = await resetChainBackend();
      applyConfig(defaults);
      setNode(DEFAULT_NODE);
      setSavedFingerprint(
        activeFingerprint(defaults.kind, defaults.electrum, DEFAULT_NODE),
      );
      pushToast("success", "Settings reset to defaults.");
    } catch (e) {
      pushToast(
        "error",
        (e as { message?: string })?.message ??
          "Could not reset the connection.",
      );
    }
  }

  async function lockAndReload() {
    try {
      await shutdownTaker();
    } catch (e) {
      pushToast(
        "error",
        (e as { message?: string })?.message ?? "Wallet could not be locked.",
      );
      return;
    }
    resetWalletCache();
    resetSession();
    // This page is outside RequireTaker, so nothing bounces us out on its own. Makers keep
    // running: shutdown_taker doesn't touch them, and neither does this.
    navigate("/launch", { replace: true });
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
    if (!backupPassword)
      return setBackupError("Please enter a backup password.");
    if (backupPassword.length < 8)
      return setBackupError("Password must be at least 8 characters.");
    if (backupPassword !== backupConfirm)
      return setBackupError("Passwords do not match.");
    void performBackup(backupPassword);
  }

  async function performBackup(password: string) {
    setBackingUp(true);
    try {
      const displayName = await backupWallet(password);
      pushToast("success", `Encrypted backup created: ${displayName}`);
      setBackupOpen(false);
    } catch (e) {
      if ((e as { code?: string })?.code === "USER_CANCELLED") return;
      pushToast(
        "error",
        `Backup failed: ${(e as { message?: string })?.message ?? "unknown error"}`,
      );
    } finally {
      setBackupPassword("");
      setBackupConfirm("");
      setBackingUp(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[1380px] pb-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-header text-[28px] font-bold leading-none text-foreground">
              Settings
            </h1>
            <p className="mt-2 text-[12.5px] text-muted">
              {takerUnlocked
                ? "Manage wallet backup, chain connection, and Tor configuration."
                : "Manage chain connection and Tor configuration."}
            </p>
          </div>
          <Button variant="secondary" onClick={() => setConfirmReset(true)}>
            Reset to defaults
          </Button>
        </header>

        {/* A maker re-reads the saved backend on its next start, so it needs no equivalent
            prompt — only a running taker is pinned to the connection it booted with. */}
        {needsReload && takerUnlocked && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-card border border-warning/40 bg-warning/10 px-5 py-4">
            <p className="text-[12.5px] text-muted">
              The chain connection changed. This wallet is still using the
              previous connection until it is reloaded.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void lockAndReload()}
            >
              <Lock size={13} strokeWidth={2} /> Lock &amp; reload wallet
            </Button>
          </div>
        )}

        <SettingsSection
          className="mt-6"
          title="Connection status"
          subtitle="The chain source currently configured for this wallet"
          bodyClassName="block p-0"
          headerMeta={
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] ${
                status === null
                  ? "border-line bg-surface-raised text-subtle"
                  : status.reachable
                    ? "border-success/35 bg-success/[0.08] text-success"
                    : "border-danger/35 bg-danger/[0.08] text-danger"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  status === null
                    ? "bg-subtle"
                    : status.reachable
                      ? "bg-success"
                      : "bg-danger"
                }`}
              />
              {status === null
                ? "Checking"
                : status.reachable
                  ? "Connected"
                  : "Not connected"}
            </span>
          }
        >
          <div className="grid grid-cols-4 divide-x divide-line max-[760px]:grid-cols-2 max-[760px]:divide-x-0">
            {[
              ["Source", kind === "coreRpc" ? "Bitcoin Core" : "Electrum"],
              ["Network", status?.chain ?? "—"],
              [
                "Block height",
                status?.blocks !== undefined
                  ? status.blocks.toLocaleString()
                  : "—",
              ],
              [
                "Sync progress",
                status?.verificationProgress !== undefined
                  ? `${(status.verificationProgress * 100).toFixed(1)}%`
                  : "—",
              ],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 px-5 py-4">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
                  {label}
                </span>
                <strong className="mt-1.5 block truncate font-mono text-[14px] text-foreground">
                  {value}
                </strong>
              </div>
            ))}
          </div>
        </SettingsSection>

        <div className="mt-4 grid grid-flow-row-dense grid-cols-2 items-start gap-4 max-[980px]:grid-cols-1">
          <SettingsSection
            title="Electrum server"
            subtitle="Choose the server and whether to reach it directly or over Tor"
            headerMeta={<ActiveBadge active={kind === "electrum"} />}
          >
            <p className="col-span-2 text-[12px] leading-5 text-muted max-[620px]:col-span-1">
              Direct connections are faster and more reliable. Tor hides your
              IP address, but a slow circuit can delay wallet synchronization.
            </p>
            <div className="col-span-2 max-[620px]:col-span-1">
              <TextField
                label="Server URL"
                placeholder="tcp://host:50001"
                value={electrum.url}
                onChange={(e) =>
                  setElectrum((current) => ({
                    ...current,
                    url: e.target.value,
                  }))
                }
              />
            </div>
            <div className="col-span-2 flex flex-wrap items-end justify-between gap-3 max-[620px]:col-span-1">
              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-muted">
                  Route
                </label>
                <SegmentedToggle
                  groupId="electrum-route"
                  value={electrumRoute}
                  onChange={(value) =>
                    setElectrum((current) => ({
                      ...current,
                      useTor: value === "tor",
                    }))
                  }
                  options={[
                    {
                      value: "direct",
                      label: "Direct",
                      disabled: onionUrl,
                      title: onionUrl
                        ? "An onion address can only be reached over Tor"
                        : undefined,
                    },
                    { value: "tor", label: "Via Tor" },
                  ]}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void testElectrum()}
                  loading={testingElectrum}
                >
                  Test connection
                </Button>
                {kind !== "electrum" && (
                  <Button
                    size="sm"
                    onClick={() => void persistBackend("electrum", false)}
                  >
                    Use Electrum
                  </Button>
                )}
              </div>
            </div>
            {electrumRows && (
              <div className="col-span-2 max-[620px]:col-span-1">
                <TestResultRows rows={electrumRows} />
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            className="row-span-2 max-[980px]:row-span-1"
            title="Bitcoin Core node"
            subtitle="Connect directly to a node you operate using RPC and ZMQ"
            headerMeta={<ActiveBadge active={kind === "coreRpc"} />}
          >
            <div>
              <SummaryGroup title="Node connection">
                <SummaryRow
                  label="RPC Host"
                  value={node.host}
                  inputMode="text"
                  onCommit={(host) =>
                    setNode((current) => ({ ...current, host }))
                  }
                />
                <SummaryRow
                  label="RPC Port"
                  value={String(node.port)}
                  onCommit={(port) =>
                    setNode((current) => ({
                      ...current,
                      port: Number(port) || current.port,
                    }))
                  }
                />
                <SummaryRow
                  label="RPC Username"
                  value={node.username}
                  inputMode="text"
                  onCommit={(username) =>
                    setNode((current) => ({ ...current, username }))
                  }
                />
              </SummaryGroup>
              <div className="mt-3">
                <PasswordField
                  label="RPC Password"
                  placeholder={
                    node.passwordConfigured
                      ? "Stored password (enter to replace)"
                      : "Enter RPC password"
                  }
                  value={node.password}
                  onChange={(e) =>
                    setNode((current) => ({
                      ...current,
                      password: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="mt-3">
                <SummaryGroup title="Notifications">
                  <SummaryRow
                    label="ZMQ Port"
                    value={String(node.zmqPort)}
                    onCommit={(zmqPort) =>
                      setNode((current) => ({
                        ...current,
                        zmqPort: Number(zmqPort) || current.zmqPort,
                      }))
                    }
                  />
                </SummaryGroup>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                bitcoin.conf snippet
                <span>Read-only</span>
              </div>
              <pre className="mt-2 whitespace-pre-wrap rounded-card border border-line bg-surface-raised p-3 font-mono text-[11px] leading-5 text-muted">
                {`zmqpubrawblock=tcp://127.0.0.1:${node.zmqPort}\nzmqpubrawtx=tcp://127.0.0.1:${node.zmqPort}`}
              </pre>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2.5 w-full justify-center"
                onClick={() => void copyZmqConfig()}
              >
                {copied ? (
                  <Check size={13} strokeWidth={2} />
                ) : (
                  <Copy size={13} strokeWidth={2} />
                )}
                {copied ? "Copied!" : "Copy ZMQ config"}
              </Button>
              <button
                type="button"
                onClick={() => void openUrl(BITCOIN_GUIDE_URL)}
                className="lift relative mt-2.5 flex w-full items-center justify-between rounded-card border border-line px-3 py-2.5 text-[12px] text-primary outline-none hover:border-line-strong hover:text-primary-hover focus-visible:shadow-ring"
              >
                <span className="flex items-center gap-1.5">
                  <ExternalLink size={14} strokeWidth={2} /> Setup guide
                </span>
                <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-subtle">
                  Open docs →
                </span>
              </button>
            </div>

            <div className="col-span-2 flex flex-wrap gap-2 max-[620px]:col-span-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void testNode()}
                loading={testingNode}
              >
                Test connection
              </Button>
              <Button
                size="sm"
                onClick={() => void persistBackend("coreRpc", true)}
              >
                {kind === "coreRpc" ? "Save node" : "Use this node"}
              </Button>
            </div>
            {nodeRows && (
              <div className="col-span-2 max-[620px]:col-span-1">
                <TestResultRows rows={nodeRows} />
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            title="Tor"
            subtitle="Shared SOCKS and control service used by private swap traffic"
          >
            <SummaryGroup title="Tor ports">
              <SummaryRow
                label="Control Port"
                value={String(tor.torControlPort)}
                onCommit={(value) =>
                  setTor((current) => ({
                    ...current,
                    torControlPort:
                      Number(value) || current.torControlPort,
                  }))
                }
              />
              <SummaryRow
                label="SOCKS Port"
                value={String(tor.torSocksPort)}
                onCommit={(value) =>
                  setTor((current) => ({
                    ...current,
                    torSocksPort: Number(value) || current.torSocksPort,
                  }))
                }
              />
            </SummaryGroup>
            <PasswordField
              label="Auth Password"
              placeholder="Optional"
              value={tor.torAuthPassword}
              onChange={(e) =>
                setTor((current) => ({
                  ...current,
                  torAuthPassword: e.target.value,
                }))
              }
            />
            <div className="col-span-2 max-[620px]:col-span-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void testTor()}
                loading={testingTor}
              >
                Test Tor
              </Button>
              {torRows && <TestResultRows rows={torRows} />}
            </div>
          </SettingsSection>

          {takerUnlocked && <SettingsSection
            className="col-span-2 max-[980px]:col-span-1"
            title="Wallet backup"
            subtitle="Create an encrypted export for recovery or migration"
            bodyClassName="block p-5"
          >
            <p className="text-[12px] leading-5 text-muted">
              The backup contains wallet data and swap history. Protect it with
              a strong password and keep that password somewhere safe—the same
              password is required when restoring it.
            </p>
            {!backupOpen ? (
              <Button
                className="mt-4 w-full justify-center"
                onClick={() => setBackupOpen(true)}
              >
                <Save size={15} strokeWidth={2} /> Create backup
              </Button>
            ) : (
              <div className="mt-4">
                <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
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
                {backupError && (
                  <p className="mt-2 text-[12px] text-danger">
                    {backupError}
                  </p>
                )}
                <Button
                  className="mt-3 w-full justify-center"
                  onClick={submitBackup}
                  loading={backingUp}
                >
                  <Check size={14} strokeWidth={2} /> Confirm &amp; create backup
                </Button>
              </div>
            )}
          </SettingsSection>}
        </div>

        {/* /logs is the taker's debug.log; each maker's own log lives in its workspace. */}
        {takerUnlocked && <SettingsSection
          className="mt-4"
          title="Utilities"
          subtitle="Diagnostics and local application records"
          bodyClassName="block p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong className="text-[12.5px] text-foreground">
                Application logs
              </strong>
              <p className="mt-1 text-[11.5px] text-muted">
                View and filter the tail of this session's debug log.
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigate("/logs")}
            >
              <ScrollText size={14} strokeWidth={2} /> View logs
            </Button>
          </div>
        </SettingsSection>}

        <Card className="mt-4 border-line-strong p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-header text-[14px] font-bold text-foreground">
                Save configuration
              </h2>
              <p className="mt-1 text-[11.5px] text-muted">
                {settingsDirty
                  ? "Unsaved connection or Tor changes are ready to save."
                  : needsReload
                    ? takerUnlocked
                      ? "Settings are saved. Reload the wallet to use the new chain connection."
                      : "Settings are saved. Restart a maker to use the new chain connection."
                    : "Connection and Tor settings are up to date."}
              </p>
            </div>
            <Button onClick={() => void persistBackend(kind, false)}>
              <Save size={14} strokeWidth={2} /> Save settings
            </Button>
          </div>
        </Card>
      </div>

      {confirmReset && (
        <Modal
          title="Reset all settings?"
          onClose={() => setConfirmReset(false)}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </Button>
              <Button onClick={() => void handleResetConfirmed()}>Reset</Button>
            </>
          }
        >
          <p className="text-[13px] text-muted">
            This restores the bundled Electrum server, forgets the node you
            added, and resets Tor ports back to their defaults. It does not
            affect your wallet or funds.
          </p>
        </Modal>
      )}
    </div>
  );
}
