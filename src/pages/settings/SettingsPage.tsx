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
  chainBackendReloadPending,
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

// Everything `save` writes, including the section that isn't currently selected — an edit
// there is still unsaved work, even though it can't change the live connection.
function configFingerprint(
  kind: ChainBackendKind,
  electrum: ElectrumBackend,
  node: NodeBackend,
) {
  return `${kind}|${electrum.url}|${electrum.useTor}|${node.host}|${node.port}|${node.username}|${node.zmqPort}`;
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

// "In use" is what the saved config says; "Selected" is a pending switch the save button
// still has to commit, so the two must not be conflated.
function BackendBadge({ inUse, selected }: { inUse: boolean; selected: boolean }) {
  if (!inUse && !selected) return null;
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-widest ${
        inUse ? "bg-primary/15 text-primary" : "bg-warning/15 text-warning"
      }`}
    >
      {inUse ? "In use" : "Selected"}
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

  // Read-only here: Portal starts and authenticates Tor itself, and the ports are only
  // editable from the setup flow that has to get past them.
  const [tor, setTor] = useState<ConnectivityConfig>(loadConnectivityDefaults);

  const [kind, setKind] = useState<ChainBackendKind>("electrum");
  const [savedKind, setSavedKind] = useState<ChainBackendKind>("electrum");
  const [electrum, setElectrum] = useState<ElectrumBackend>({
    url: "",
    useTor: false,
  });
  const [node, setNode] = useState<NodeBackend>(DEFAULT_NODE);
  const [nodeAdded, setNodeAdded] = useState(false);
  // From the running taker, not from disk: the saved config says nothing about the route
  // the live session is already pinned to, so a page revisit would otherwise look settled.
  const [needsReload, setNeedsReload] = useState(false);
  const [savedConfigFingerprint, setSavedConfigFingerprint] = useState<string | null>(null);

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
  const settingsDirty =
    savedConfigFingerprint !== null &&
    configFingerprint(kind, electrum, node) !== savedConfigFingerprint;

  useEffect(() => {
    void getChainBackend()
      .then((c) => {
        applyConfig(c);
        setSavedConfigFingerprint(
          configFingerprint(c.kind, c.electrum, c.node ?? DEFAULT_NODE),
        );
        void refreshReloadPending();
        return checkBackend(undefined, loadConnectivityDefaults().torSocksPort);
      })
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function refreshReloadPending() {
    const pending = await chainBackendReloadPending().catch(() => false);
    setNeedsReload(pending);
    return pending;
  }

  function applyConfig(c: ChainBackendConfig) {
    setKind(c.kind);
    setSavedKind(c.kind);
    setElectrum(c.electrum);
    setNodeAdded(c.node !== null);
    if (c.node) setNode({ ...c.node, password: "" });
  }

  async function persistBackend() {
    const config: ChainBackendConfig = {
      kind,
      electrum: { ...electrum, useTor: electrum.useTor || onionUrl },
      node: nodeAdded ? node : null,
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
    setSavedConfigFingerprint(
      configFingerprint(config.kind, config.electrum, config.node ?? DEFAULT_NODE),
    );
    pushToast(
      "success",
      (await refreshReloadPending())
        ? "Settings saved. Reload the wallet to start using the new connection."
        : "Settings saved.",
    );
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
        ok: torResult.status === "fulfilled" && torResult.value.socksReachable,
        message:
          torResult.status === "fulfilled"
            ? torResult.value.socksReachable
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
    // The only way back from Tor ports that setup was talked into accepting, since this
    // page no longer exposes them.
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
      setSavedConfigFingerprint(
        configFingerprint(defaults.kind, defaults.electrum, DEFAULT_NODE),
      );
      await refreshReloadPending();
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
          <div className="flex gap-2">
            {/* /logs is the taker's debug.log; each maker's own log lives in its workspace. */}
            {takerUnlocked && (
              <Button variant="secondary" onClick={() => navigate("/logs")}>
                <ScrollText size={14} strokeWidth={2} /> View logs
              </Button>
            )}
            <Button variant="secondary" onClick={() => setConfirmReset(true)}>
              Reset to defaults
            </Button>
          </div>
        </header>

        {/* A maker re-reads the saved backend on its next start, so it needs no equivalent
            prompt — only a running taker is pinned to the connection it booted with. */}
        {needsReload && takerUnlocked && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-card border border-warning/40 bg-warning/10 px-5 py-4">
            <p className="text-[12.5px] text-muted">
              Saved. The new chain connection is used the next time the taker is
              initialized — this wallet stays on the previous one until then.
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

        <div className="mt-4 grid grid-cols-2 items-start gap-4 max-[980px]:grid-cols-1">
          <SettingsSection
            title="Electrum server"
            subtitle="Choose the server and whether to reach it directly or over Tor"
            headerMeta={<BackendBadge inUse={savedKind === "electrum"} selected={kind === "electrum"} />}
          >
            <div className="col-span-2 max-[620px]:col-span-1">
              <SummaryGroup title="Server">
                <SummaryRow
                  label="Server URL"
                  value={electrum.url}
                  inputMode="text"
                  onCommit={(url) =>
                    setElectrum((current) => ({ ...current, url }))
                  }
                />
              </SummaryGroup>
            </div>
            <div className="col-span-2 flex flex-wrap items-end justify-between gap-3 max-[620px]:col-span-1">
              <div className="flex flex-col gap-1.5">
                <label className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
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
                  <Button size="sm" onClick={() => setKind("electrum")}>
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
            title="Bitcoin Core node"
            subtitle="Connect directly to a node you operate using RPC and ZMQ"
            headerMeta={<BackendBadge inUse={savedKind === "coreRpc"} selected={kind === "coreRpc"} />}
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
                variant="secondary"
                onClick={() => void copyZmqConfig()}
              >
                {copied ? (
                  <Check size={13} strokeWidth={2} />
                ) : (
                  <Copy size={13} strokeWidth={2} />
                )}
                {copied ? "Copied" : "Copy ZMQ config"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void openUrl(BITCOIN_GUIDE_URL)}
              >
                <ExternalLink size={13} strokeWidth={2} /> Setup guide
              </Button>
              {kind !== "coreRpc" && (
                <Button
                  size="sm"
                  onClick={() => {
                    setNodeAdded(true);
                    setKind("coreRpc");
                  }}
                >
                  Use this node
                </Button>
              )}
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
            <p className="col-span-2 text-[12px] leading-5 text-muted max-[620px]:col-span-1">
              Portal starts and authenticates Tor itself, reusing one already running if
              it finds it. Ports {tor.torSocksPort} and {tor.torControlPort} are in use.
            </p>
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
                size="sm"
                className="mt-4"
                onClick={() => setBackupOpen(true)}
              >
                <Save size={14} strokeWidth={2} /> Create backup
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
                  size="sm"
                  className="mt-3"
                  onClick={submitBackup}
                  loading={backingUp}
                >
                  <Check size={14} strokeWidth={2} /> Confirm &amp; create backup
                </Button>
              </div>
            )}
          </SettingsSection>}
        </div>

        <Card className="mt-4 border-line-strong p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-header text-[14px] font-bold text-foreground">
                Save configuration
              </h2>
              <p className="mt-1 text-[11.5px] text-muted">
                {settingsDirty
                  ? "Saving takes effect the next time the taker is initialized."
                  : needsReload
                    ? takerUnlocked
                      ? "Saved. Reload the wallet to switch to the new connection now."
                      : "Saved. Restart a maker to use the new chain connection."
                    : "Connection settings are up to date."}
              </p>
            </div>
            <Button
              disabled={!settingsDirty}
              onClick={() => void persistBackend()}
            >
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
