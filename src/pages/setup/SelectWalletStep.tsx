import { open } from "@tauri-apps/plugin-dialog";
import { dirname } from "@tauri-apps/api/path";
import { FolderOpen, FolderPlus, Plus } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { checkBackend, checkTor, getChainBackend, initTaker, listWallets, restoreWallet, syncOfferbook } from "../../api/commands";
import { isAppError } from "../../api/types";
import type { ChainBackendKind, InitResult } from "../../api/types";
import { Card, Modal, WalletCard } from "../../components/ui/display";
import { Button, PasswordField, TextField } from "../../components/ui/inputs";
import { Checklist, type CheckState } from "../../components/ui/Checklist";
import { IntroStage } from "../../components/ui/IntroStage";
import { wait, withMinDelay } from "../../lib/timing";
import { walletIdentity } from "../../lib/wallet-identity";
import {
  loadConnectivityDefaults,
  saveConnectivityDefaults,
  type ConnectivityConfig,
} from "../../lib/connectivity";
import {
  getDefaultDataDir,
  getDefaultWalletsDir,
  loadDataDir,
  saveDataDir,
  type WalletChoice,
} from "./types";

interface SelectWalletStepProps {
  onSuccess: (result: InitResult, restored: boolean) => void;
}

type ViewMode = "grid" | "unlock" | "create" | "checking";
type CheckStage = "backend" | "tor" | "wallet";

interface CheckFailure {
  stage: CheckStage;
  message: string;
}

interface Steps {
  backend: CheckState;
  tor: CheckState;
  verify: CheckState;
  init: CheckState;
}

// The same curve IntroStage enters on, so the grid inherits the stage's motion signature.
const RISE = [0.16, 1, 0.3, 1] as const;

const IDLE_STEPS: Steps = { backend: "idle", tor: "idle", verify: "idle", init: "idle" };

function randomWalletName() {
  return `taker-wallet-${Math.floor(100000 + Math.random() * 900000)}`;
}

function basename(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

// Local checks (RPC/Tor/wallet unlock) often resolve in well under 100ms,
// which makes the sequential checklist flash by unreadably.
const MIN_STEP_MS = 900;

// The crate refuses to create an unencrypted wallet, so this is a floor, not a style rule.
const MIN_PASSWORD = 8;

const CAPTIONS: Record<ViewMode, string> = {
  grid: "Select your wallet",
  unlock: "Unlock your wallet",
  create: "Create a new wallet",
  checking: "Setting things up",
};

function onEnter(fn: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") fn();
  };
}

export function SelectWalletStep({ onSuccess }: SelectWalletStepProps) {
  const [dataDir, setDataDir] = useState<string | undefined>(loadDataDir);
  // null while a folder scan is in flight. The intro plays over it rather than waiting.
  const [wallets, setWallets] = useState<string[] | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");

  const [createName, setCreateName] = useState(randomWalletName());
  const [createPassword, setCreatePassword] = useState("");
  const [createConfirm, setCreateConfirm] = useState("");

  const [connectivity, setConnectivity] = useState<ConnectivityConfig>(loadConnectivityDefaults);
  const [steps, setSteps] = useState<Steps>(IDLE_STEPS);
  const [failure, setFailure] = useState<CheckFailure | null>(null);
  const [pendingWallet, setPendingWallet] = useState<WalletChoice | null>(null);
  const [retryPassword, setRetryPassword] = useState("");
  const [backendKind, setBackendKind] = useState<ChainBackendKind>("electrum");
  const backendLabel = backendKind === "coreRpc" ? "your Bitcoin node" : "the Electrum server";

  useEffect(() => {
    refreshWallets(dataDir);
    void getChainBackend()
      .then((c) => setBackendKind(c.kind))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshWallets(dir?: string) {
    setWallets(null);
    // An unreadable folder is indistinguishable from an empty one here, and both lead to the
    // same place: the create form.
    const found = await listWallets(dir).catch(() => []);
    setWallets(found);
    // With nothing to unlock, creating is the only way forward — open the form directly
    // rather than making the user dismiss an empty-state panel first. Back still reaches
    // the grid, so Change location / Load wallet stay available.
    if (found.length === 0) return setViewMode("create");
    // A one-wallet grid is a single card whose only purpose is to be clicked, so skip it and
    // ask for the password directly. The unlock view carries the same location/create/load
    // actions, so nothing becomes unreachable.
    if (found.length === 1) return selectWallet(found[0]);
    setViewMode("grid");
  }

  function selectWallet(name: string) {
    setSelectedWallet(name);
    setUnlockPassword("");
    setViewMode("unlock");
  }

  async function changeLocation() {
    const path = await open({ directory: true, defaultPath: dataDir ?? (await getDefaultDataDir()) });
    if (typeof path !== "string") return;
    setDataDir(path);
    saveDataDir(path);
    refreshWallets(path);
  }

  async function loadWalletFile() {
    const path = await open({ multiple: false, defaultPath: dataDir ?? (await getDefaultWalletsDir()) });
    if (typeof path !== "string") return;
    // Wallet files live at <data_dir>/wallets/<name> — if this file is
    // outside the current data dir, adopt its parent as the new data dir.
    const walletsDir = await dirname(path);
    const newDataDir = await dirname(walletsDir);
    setDataDir(newDataDir);
    saveDataDir(newDataDir);
    selectWallet(basename(path));
  }

  // Validated as the user types so the submit stays disabled, rather than accepting the click
  // and reporting what's wrong afterwards.
  const canCreate =
    createName.trim().length > 0 && createPassword.length >= MIN_PASSWORD && createPassword === createConfirm;

  function submitCreate() {
    if (!canCreate) return;
    runChecks({ mode: "create", walletName: createName.trim(), password: createPassword });
  }

  function submitUnlock() {
    if (!selectedWallet) return;
    runChecks({ mode: "load", walletName: selectedWallet, password: unlockPassword });
  }

  async function runChecks(wallet: WalletChoice) {
    setPendingWallet(wallet);
    setFailure(null);
    setViewMode("checking");
    setSteps({ tor: "running", backend: "idle", verify: "idle", init: "idle" });

    // Tor first: the taker's own connection type is Tor, and a Tor-routed chain backend
    // would otherwise surface a dead proxy as a misleading "backend unreachable".
    try {
      await withMinDelay(
        (async () => {
          const status = await checkTor(connectivity.torSocksPort, connectivity.torControlPort, connectivity.torAuthPassword);
          if (!(status.reachable && status.authenticated)) {
            throw new Error(status.error ?? "Tor control port unreachable.");
          }
        })(),
        MIN_STEP_MS,
      );
    } catch (e) {
      setSteps((s) => ({ ...s, tor: "failed" }));
      setFailure({ stage: "tor", message: (e as { message?: string })?.message ?? "Could not reach Tor." });
      return;
    }
    setSteps((s) => ({ ...s, tor: "passed", backend: "running" }));

    try {
      await withMinDelay(
        (async () => {
          const status = await checkBackend(undefined, connectivity.torSocksPort);
          if (!status.reachable) {
            throw new Error(status.error ?? `Could not reach ${backendLabel}.`);
          }
        })(),
        MIN_STEP_MS,
      );
    } catch (e) {
      setSteps((s) => ({ ...s, backend: "failed" }));
      setFailure({ stage: "backend", message: (e as { message?: string })?.message ?? `Could not reach ${backendLabel}.` });
      return;
    }
    setSteps((s) => ({ ...s, backend: "passed", verify: "running" }));
    await wait(MIN_STEP_MS);
    setSteps((s) => ({ ...s, verify: "passed", init: "running" }));

    try {
      const result = await withMinDelay(
        (async () => {
          if (wallet.mode === "restore") {
            await restoreWallet(wallet.walletName, connectivity.torSocksPort, wallet.backupFilePath, wallet.password, dataDir);
          }
          return initTaker({
            walletName: wallet.walletName,
            walletPassword: wallet.password,
            controlPort: connectivity.torControlPort,
            socksPort: connectivity.torSocksPort,
            torAuthPassword: connectivity.torAuthPassword,
            connectionType: "tor",
            dataDir,
          });
        })(),
        MIN_STEP_MS,
      );
      setSteps((s) => ({ ...s, init: "passed" }));
      saveConnectivityDefaults(connectivity);
      // Kick off a real offerbook sync now, in the background, so the Market page has fresh
      // maker data by the time the user looks at it — not just whatever offerbook.json had from
      // the last session. Not awaited: this can take 30-60s+ and shouldn't block navigation.
      void syncOfferbook().catch(() => {});
      // restore_wallet completes its own sync_and_save before init_taker, so a
      // successful restore already satisfies the mandatory first scan.
      onSuccess(result, wallet.mode === "restore");
    } catch (e) {
      const err = isAppError(e) ? e : null;
      setSteps((s) => ({ ...s, verify: "failed", init: "failed" }));
      setFailure({
        stage: "wallet",
        message:
          err?.code === "WALLET_WRONG_PASSWORD" ? "Incorrect password. Try again." : (err?.message ?? "Something went wrong."),
      });
    }
  }

  function retry() {
    if (!pendingWallet) return;
    if (failure?.stage === "wallet") {
      runChecks({ ...pendingWallet, password: retryPassword });
    } else {
      runChecks(pendingWallet);
    }
  }

  function cancelFailure() {
    setFailure(null);
    setViewMode(pendingWallet?.mode === "create" ? "create" : "unlock");
  }

  const firstRun = wallets?.length === 0;
  const unlockIdentity = useMemo(() => walletIdentity(selectedWallet ?? ""), [selectedWallet]);

  const createFields = (
    <div className="flex flex-col gap-5 text-left">
      <TextField
        label="Wallet name"
        value={createName}
        onChange={(e) => setCreateName(e.target.value)}
        error={createName.trim() ? undefined : "Wallet name is required."}
      />
      <PasswordField
        label="Password"
        value={createPassword}
        onChange={(e) => setCreatePassword(e.target.value)}
        hint={
          createPassword.length > 0 && createPassword.length < MIN_PASSWORD
            ? "At least 8 characters. An unencrypted wallet is not permitted — losing this password means losing access to funds."
            : undefined
        }
      />
      <PasswordField
        label="Confirm password"
        value={createConfirm}
        onChange={(e) => setCreateConfirm(e.target.value)}
        onKeyDown={onEnter(submitCreate)}
        error={createConfirm.length > 0 && createConfirm !== createPassword ? "Passwords don't match." : undefined}
      />
    </div>
  );

  // Shared by the grid footer and the unlock footer: skipping the grid for a lone wallet must
  // not also skip the only route to a different folder, file, or new wallet.
  const walletActions = (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5">
      <Button variant="ghost" size="sm" className="px-2.5 text-[11.5px]" onClick={changeLocation}>
        <FolderOpen size={13} strokeWidth={1.8} />
        Change location
      </Button>
      <Button variant="ghost" size="sm" className="px-2.5 text-[11.5px]" onClick={loadWalletFile}>
        <FolderPlus size={13} strokeWidth={1.8} />
        Load wallet
      </Button>
      <Button variant="ghost" size="sm" className="px-2.5 text-[11.5px]" onClick={() => setViewMode("create")}>
        <Plus size={13} strokeWidth={1.8} />
        Create new wallet
      </Button>
    </div>
  );

  const createActions = (
    <div className="flex gap-3">
      {/* Create is the default view with no wallets on disk, so this is the only route to
          Change location / Load wallet — label it for what it reaches, not as "Back". */}
      <Button variant="secondary" onClick={() => setViewMode("grid")}>
        {firstRun ? "Use existing" : "Back"}
      </Button>
      <Button className="flex-1" disabled={!canCreate} onClick={submitCreate}>
        Create &amp; continue
      </Button>
    </div>
  );

  const checklist = (
    <Checklist
      steps={[
        { label: "Checking Tor", state: steps.tor },
        { label: `Checking ${backendLabel}`, state: steps.backend },
        { label: "Verifying wallet password", state: steps.verify },
        { label: "Initializing taker", state: steps.init },
      ]}
    />
  );

  const failureModal = failure && (
    <Modal
      title={
        failure.stage === "backend"
          ? `Can't reach ${backendLabel}`
          : failure.stage === "tor"
            ? "Can't reach Tor"
            : "Couldn't unlock wallet"
      }
      onClose={cancelFailure}
      footer={
        <>
          <Button variant="secondary" onClick={cancelFailure}>
            Cancel
          </Button>
          <Button onClick={retry}>Retry</Button>
        </>
      }
    >
      <p className="text-[12.5px] text-danger">{failure.message}</p>

      {failure.stage === "tor" && (
        <>
          <TextField
            label="SOCKS port"
            value={connectivity.torSocksPort}
            onChange={(e) => setConnectivity((c) => ({ ...c, torSocksPort: Number(e.target.value) }))}
          />
          <TextField
            label="Control port"
            value={connectivity.torControlPort}
            onChange={(e) => setConnectivity((c) => ({ ...c, torControlPort: Number(e.target.value) }))}
          />
          <PasswordField
            label="Control port auth password (optional)"
            value={connectivity.torAuthPassword}
            onChange={(e) => setConnectivity((c) => ({ ...c, torAuthPassword: e.target.value }))}
            onKeyDown={onEnter(retry)}
          />
        </>
      )}

      {failure.stage === "wallet" && (
        <PasswordField
          label="Password"
          value={retryPassword}
          onChange={(e) => setRetryPassword(e.target.value)}
          onKeyDown={onEnter(retry)}
          placeholder="Enter wallet password"
          autoFocus
        />
      )}
    </Modal>
  );

  return (
    <>
      <IntroStage lead="Welcome to" accent="OpenSwap" caption={CAPTIONS[viewMode]} className="min-h-screen">
        {/* The grid needs room for two wallet cards abreast; every other view is a single
            column and looks stranded at that width. */}
        <div className={`mx-auto w-full ${viewMode === "grid" ? "max-w-2xl" : viewMode === "unlock" ? "max-w-xl" : "max-w-lg"}`}>
          {/* Panelled so the contents read as one object against the empty screen. Actions sit
              in a footer inside it rather than loose underneath, which would leave the box
              looking unfinished at the bottom. */}
          <Card className="border-line-strong">
            {viewMode === "grid" && (
              <>
                <div className="p-8">
                  {wallets === null ? (
                    <p className="text-center text-[13px] text-muted">Looking for wallets…</p>
                  ) : wallets.length === 0 ? (
                    <div className="rounded-card border border-dashed border-line-strong px-8 py-10 text-center">
                      <p className="text-[14px] font-medium text-foreground">No wallets found</p>
                      <p className="mt-1 text-[12.5px] text-muted">
                        Create a new wallet to get started, or point the app at a different folder.
                      </p>
                      <Button className="mt-5" onClick={() => setViewMode("create")}>
                        Create new wallet
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap justify-center gap-4">
                      {wallets.map((name, i) => (
                        <motion.div
                          key={name}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.42, delay: i * 0.07, ease: RISE }}
                        >
                          <WalletCard name={name} onClick={() => selectWallet(name)} />
                        </motion.div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="border-t border-line px-8 pb-5 pt-1">{walletActions}</div>
              </>
            )}

            {viewMode === "unlock" && selectedWallet && (
              <>
                <div className="px-8 pb-8 pt-9">
                  {/* Concentric rings read as an aperture closed over the wallet, and give the
                      emblem a size the bare name never had. Tinted by the wallet's own identity
                      so this screen and its card in the grid are recognisably the same wallet. */}
                  <div className="relative mx-auto grid h-16 w-16 place-items-center">
                    <span className="absolute -inset-7 rounded-full border" style={{ borderColor: unlockIdentity.edge, opacity: 0.3 }} />
                    <span className="absolute -inset-3.5 rounded-full border" style={{ borderColor: unlockIdentity.edge, opacity: 0.6 }} />
                    <span
                      className="absolute -inset-3.5 rounded-full"
                      style={{ background: `radial-gradient(circle, ${unlockIdentity.glow}, transparent 72%)` }}
                    />
                    <span
                      className="relative grid h-16 w-16 place-items-center rounded-full border font-header text-[19px] font-bold"
                      style={{ color: unlockIdentity.ink, background: unlockIdentity.fill, borderColor: unlockIdentity.edge }}
                    >
                      {unlockIdentity.monogram}
                    </span>
                  </div>

                  <p className="mt-6 truncate text-center font-header text-[20px] font-bold text-foreground">
                    {selectedWallet}
                  </p>
                  {/* The exact file about to be opened. Cheap reassurance in a wallet, and it is
                      the only place the user can confirm which folder they are pointed at. */}
                  {dataDir && (
                    <p className="mt-1.5 truncate text-center font-mono text-[11px] text-subtle" title={`${dataDir}/wallets/${selectedWallet}`}>
                      {dataDir}/wallets/{selectedWallet}
                    </p>
                  )}

                  <div className="mt-7 text-left">
                    <PasswordField
                      label="Password"
                      value={unlockPassword}
                      onChange={(e) => setUnlockPassword(e.target.value)}
                      onKeyDown={onEnter(() => unlockPassword && submitUnlock())}
                      placeholder="Enter wallet password"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="border-t border-line px-8 py-5">
                  <div className="flex gap-3">
                    {/* Only worth offering when there is something else to go back to — with one
                        wallet on disk the grid is a single card that leads straight back here. */}
                    {(wallets?.length ?? 0) > 1 && (
                      <Button variant="secondary" className="flex-1" onClick={() => setViewMode("grid")}>
                        Back
                      </Button>
                    )}
                    <Button className="flex-1" disabled={!unlockPassword} onClick={submitUnlock}>
                      Unlock
                    </Button>
                  </div>
                  {walletActions}
                </div>
              </>
            )}

            {viewMode === "create" && (
              <>
                <div className="p-8">{createFields}</div>
                <div className="border-t border-line px-8 py-5">{createActions}</div>
              </>
            )}

            {viewMode === "checking" && <div className="p-8">{checklist}</div>}
          </Card>

          {viewMode === "grid" && dataDir && (
            <p className="mt-3 text-center text-[11.5px] text-subtle">{dataDir}/wallets</p>
          )}
        </div>
      </IntroStage>
      {failureModal}
    </>
  );
}
