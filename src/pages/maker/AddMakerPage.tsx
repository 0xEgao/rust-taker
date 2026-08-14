import { AlertTriangle, ArrowLeft, Server } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { checkBackend, checkMakerPorts, checkTor, getSuggestedMakerPorts, initMaker } from "../../api/commands";
import type { MakerInitConfig, MakerPortCheck } from "../../api/types";
import { Card, Disclosure } from "../../components/ui/display";
import { Button, PasswordField, SummaryRow, TextField } from "../../components/ui/inputs";
import { loadConnectivityDefaults } from "../../lib/connectivity";
import { useToastStore } from "../../store/toast";
import { MAKER_DEFAULTS, MAKER_ID_PATTERN } from "./maker-defaults";

// Long enough that editing a port digit-by-digit doesn't fire a check per keystroke.
const CHECK_DEBOUNCE_MS = 400;

const tor = loadConnectivityDefaults();

/** Every value shown as a summary row. Strings so an in-progress edit is representable. */
const INITIAL_VALUES = {
  socksPort: String(tor.torSocksPort),
  controlPort: String(tor.torControlPort),
  networkPort: "",
  rpcPort: "",
  minSwapAmount: String(MAKER_DEFAULTS.minSwapAmount),
  baseFee: String(MAKER_DEFAULTS.baseFee),
  amountRelativeFeePct: String(MAKER_DEFAULTS.amountRelativeFeePct),
  timeRelativeFeePct: String(MAKER_DEFAULTS.timeRelativeFeePct),
  requiredConfirms: String(MAKER_DEFAULTS.requiredConfirms),
  fidelityAmount: String(MAKER_DEFAULTS.fidelityAmount),
  fidelityTimelock: String(MAKER_DEFAULTS.fidelityTimelock),
};

type Values = typeof INITIAL_VALUES;

function group(title: string, rows: React.ReactNode, warning?: string | null) {
  return (
    <div className="border-t border-line px-5 py-4">
      <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">{title}</span>
      <div className="mt-1.5 flex flex-col">{rows}</div>
      {warning && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-5 text-danger">
          <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
          {warning}
        </p>
      )}
    </div>
  );
}

function sats(value: string) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : value;
}

export function AddMakerPage() {
  const navigate = useNavigate();
  const pushToast = useToastStore((state) => state.push);

  const [makerId, setMakerId] = useState("");
  const [walletName, setWalletName] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [walletPassword, setWalletPassword] = useState("");
  const [torAuthPassword, setTorAuthPassword] = useState(tor.torAuthPassword);
  const [values, setValues] = useState<Values>(INITIAL_VALUES);

  const [torError, setTorError] = useState<string | null>(null);
  const [portErrors, setPortErrors] = useState<MakerPortCheck>({});
  const [chain, setChain] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Bumped on every edit so a slow in-flight check can't paint a verdict for a value the
  // user has already changed.
  const torRun = useRef(0);
  const portRun = useRef(0);

  const numbers = useMemo(
    () => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])) as Record<keyof Values, number>,
    [values],
  );

  const trimmedId = makerId.trim();
  const malformedId = trimmedId.length > 0 && !MAKER_ID_PATTERN.test(trimmedId);

  useEffect(() => {
    void getSuggestedMakerPorts(tor.torSocksPort, tor.torControlPort)
      .then((ports) => setValues((v) => ({ ...v, networkPort: String(ports.networkPort), rpcPort: String(ports.rpcPort) })))
      .catch((e) => setPortErrors({ networkPort: (e as { message?: string })?.message ?? "Could not find free ports." }));
    void checkBackend()
      .then((s) => setChain(s.chain ?? null))
      .catch(() => setChain(null));
  }, []);

  // Tor was already proven working to unlock the taker, so a failure here almost always means
  // a port on this page was just edited to something wrong — hence the wording below.
  useEffect(() => {
    const { socksPort, controlPort } = numbers;
    if (!Number.isInteger(socksPort) || !Number.isInteger(controlPort) || socksPort <= 0 || controlPort <= 0) return;
    const run = ++torRun.current;
    const timer = setTimeout(() => {
      void checkTor(socksPort, controlPort, torAuthPassword)
        .then((status) => {
          if (run !== torRun.current) return;
          setTorError(
            status.reachable && status.authenticated
              ? null
              : (status.error ?? `Tor control port ${controlPort} is not reachable. Check the port or fix it in Settings.`),
          );
        })
        .catch((e) => {
          if (run === torRun.current) setTorError((e as { message?: string })?.message ?? "Tor is unreachable.");
        });
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [numbers.socksPort, numbers.controlPort, torAuthPassword]);

  useEffect(() => {
    const { networkPort, rpcPort, socksPort, controlPort } = numbers;
    if (![networkPort, rpcPort].every((p) => Number.isInteger(p) && p > 0)) return;
    const run = ++portRun.current;
    const timer = setTimeout(() => {
      void checkMakerPorts(networkPort, rpcPort, socksPort, controlPort)
        .then((result) => {
          if (run === portRun.current) setPortErrors(result);
        })
        .catch(() => {});
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [numbers.networkPort, numbers.rpcPort, numbers.socksPort, numbers.controlPort]);

  const config = useMemo<MakerInitConfig | null>(() => {
    if (!trimmedId || malformedId) return null;
    if (Object.values(numbers).some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (numbers.requiredConfirms < 1) return null;
    return {
      makerId: trimmedId,
      // A maker's wallet is its own, so the id doubles as the wallet name unless overridden.
      walletName: walletName.trim() || trimmedId,
      dataDir: dataDir.trim() || undefined,
      walletPassword: walletPassword || undefined,
      torAuthPassword: torAuthPassword || undefined,
      networkPort: numbers.networkPort,
      rpcPort: numbers.rpcPort,
      socksPort: numbers.socksPort,
      controlPort: numbers.controlPort,
      minSwapAmount: numbers.minSwapAmount,
      baseFee: numbers.baseFee,
      amountRelativeFeePct: numbers.amountRelativeFeePct,
      timeRelativeFeePct: numbers.timeRelativeFeePct,
      requiredConfirms: numbers.requiredConfirms,
      fidelityAmount: numbers.fidelityAmount,
      fidelityTimelock: numbers.fidelityTimelock,
    };
  }, [trimmedId, malformedId, walletName, dataDir, walletPassword, torAuthPassword, numbers]);

  const blocked = torError !== null || portErrors.networkPort !== undefined || portErrors.rpcPort !== undefined;

  function set(key: keyof Values) {
    return (next: string) => setValues((v) => ({ ...v, [key]: next }));
  }

  async function createMaker() {
    if (!config) return;
    setCreating(true);
    try {
      await initMaker(config);
      pushToast("success", `${config.makerId} was created and registered.`);
      navigate(`/maker/${encodeURIComponent(config.makerId)}/setup`);
    } catch (error) {
      pushToast("error", (error as { message?: string })?.message ?? "Could not create maker.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[640px] pb-8">
        <header className="mb-6">
          <Link to="/maker" className="mb-4 inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-subtle hover:text-foreground">
            <ArrowLeft size={14} />
            Back to makers
          </Link>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-lg bg-primary text-on-primary">
                <Server size={22} />
              </span>
              <div>
                <h1 className="font-header text-[29px] font-bold text-foreground">Add Maker</h1>
                <p className="mt-1 text-[12.5px] text-muted">Created stopped — start it once the fidelity bond is funded.</p>
              </div>
            </div>
            {chain && (
              <span className="rounded-pill border border-primary/35 bg-primary/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-primary">
                {chain}
              </span>
            )}
          </div>
        </header>

        <Card className="border-line-strong">
          <div className="p-5">
            <TextField
              label="Maker ID"
              placeholder="maker-02"
              autoFocus
              value={makerId}
              onChange={(e) => setMakerId(e.target.value)}
              error={malformedId ? "Letters, numbers, hyphens and underscores only." : undefined}
              hint={malformedId ? undefined : "Also names its wallet. Everything below is already set."}
            />
            <div className="mt-3">
              <Disclosure label="Wallet name, data directory, password">
                <div className="flex flex-col gap-3 pt-1">
                  <TextField label="Wallet name" placeholder={trimmedId || "Same as Maker ID"} value={walletName} onChange={(e) => setWalletName(e.target.value)} />
                  <TextField label="Data directory" placeholder="Default maker directory" value={dataDir} onChange={(e) => setDataDir(e.target.value)} />
                  <PasswordField label="Wallet password" autoComplete="new-password" value={walletPassword} onChange={(e) => setWalletPassword(e.target.value)} />
                  <PasswordField label="Tor control password" value={torAuthPassword} onChange={(e) => setTorAuthPassword(e.target.value)} />
                  <p className="text-[11.5px] leading-5 text-subtle">
                    Wallet name and data directory are permanent, and the wallet password sets the
                    wallet file's encryption — none of the three can be changed later. The Tor
                    password is only used to reach Tor and is asked for again on each start.
                  </p>
                </div>
              </Disclosure>
            </div>
          </div>

          {group(
            "Tor",
            <>
              <SummaryRow label="SOCKS port" value={values.socksPort} onCommit={set("socksPort")} />
              <SummaryRow label="Control port" value={values.controlPort} onCommit={set("controlPort")} />
            </>,
            torError,
          )}

          {group(
            "Maker ports",
            <>
              <SummaryRow label="Network port" value={values.networkPort || "…"} onCommit={set("networkPort")} />
              <SummaryRow label="RPC port" value={values.rpcPort || "…"} onCommit={set("rpcPort")} />
            </>,
            portErrors.networkPort ?? portErrors.rpcPort,
          )}

          {group(
            "Swap policy",
            <>
              <SummaryRow label="Minimum swap amount" value={values.minSwapAmount} display={sats(values.minSwapAmount)} suffix="sats" onCommit={set("minSwapAmount")} />
              <SummaryRow label="Base fee" value={values.baseFee} display={sats(values.baseFee)} suffix="sats" onCommit={set("baseFee")} />
              <SummaryRow label="Amount-relative fee" value={values.amountRelativeFeePct} suffix="%" inputMode="decimal" onCommit={set("amountRelativeFeePct")} />
              <SummaryRow label="Time-relative fee" value={values.timeRelativeFeePct} suffix="%" inputMode="decimal" onCommit={set("timeRelativeFeePct")} />
              <SummaryRow label="Required confirmations" value={values.requiredConfirms} onCommit={set("requiredConfirms")} />
            </>,
          )}

          {group(
            "Fidelity bond",
            <>
              <SummaryRow label="Target amount" value={values.fidelityAmount} display={sats(values.fidelityAmount)} suffix="sats" onCommit={set("fidelityAmount")} />
              <SummaryRow label="Timelock" value={values.fidelityTimelock} display={sats(values.fidelityTimelock)} suffix="blocks" onCommit={set("fidelityTimelock")} />
            </>,
          )}

          <div className="border-t border-line px-5 py-4">
            <p className="text-[11.5px] leading-5 text-subtle">
              These are defaults. All of them can be changed later from the maker's Settings tab.
            </p>
          </div>
        </Card>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Link to="/maker" className="inline-flex h-10 items-center rounded-control border border-line px-5 text-[13px] font-semibold text-foreground hover:border-line-strong">
            Cancel
          </Link>
          <Button onClick={() => void createMaker()} loading={creating} disabled={!config || blocked}>
            Create maker
          </Button>
        </div>
      </div>
    </div>
  );
}
