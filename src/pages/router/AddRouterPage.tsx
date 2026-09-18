import { AlertTriangle, ArrowLeft, Server } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { checkBackend, checkRouterPorts, checkTor, getSuggestedRouterPorts, initRouter } from "../../api/commands";
import type { RouterInitConfig, RouterPortCheck } from "../../api/types";
import { Card, Disclosure } from "../../components/ui/display";
import { Button, LinkButton, PasswordField, SummaryGroup, SummaryRow, TextField } from "../../components/ui/inputs";
import { validateNewPassword } from "../../lib/password-policy";
import { useToastStore } from "../../store/toast";
import { ROUTER_DEFAULTS, ROUTER_ID_PATTERN, timelockDays } from "./router-defaults";

// Long enough that editing a port digit-by-digit doesn't fire a check per keystroke.
const CHECK_DEBOUNCE_MS = 400;

/** Every value shown as a summary row. Strings so an in-progress edit is representable. */
const INITIAL_VALUES = {
  socksPort: "",
  controlPort: "",
  networkPort: "",
  rpcPort: "",
  minSwapAmount: String(ROUTER_DEFAULTS.minSwapAmount),
  baseFee: String(ROUTER_DEFAULTS.baseFee),
  amountRelativeFeePct: String(ROUTER_DEFAULTS.amountRelativeFeePct),
  timeRelativeFeePct: String(ROUTER_DEFAULTS.timeRelativeFeePct),
  requiredConfirms: String(ROUTER_DEFAULTS.requiredConfirms),
  fidelityAmount: String(ROUTER_DEFAULTS.fidelityAmount),
  fidelityTimelock: String(ROUTER_DEFAULTS.fidelityTimelock),
};

type Values = typeof INITIAL_VALUES;

function group(title: string, rows: React.ReactNode, warning?: string | null) {
  return (
    <div className="border-t border-line px-5 py-4">
      <SummaryGroup title={title} warning={warning ? <p className="flex items-start gap-1.5 text-[10.5px] text-danger">
          <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
          {warning}
        </p> : undefined}>{rows}</SummaryGroup>
    </div>
  );
}

function sats(value: string) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : value;
}

export function AddRouterPage() {
  const navigate = useNavigate();
  const pushToast = useToastStore((state) => state.push);

  const [routerId, setRouterId] = useState("");
  const [walletName, setWalletName] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [walletPassword, setWalletPassword] = useState("");
  const [walletPasswordConfirm, setWalletPasswordConfirm] = useState("");
  const [values, setValues] = useState<Values>(INITIAL_VALUES);

  const [torError, setTorError] = useState<string | null>(null);
  const [portErrors, setPortErrors] = useState<RouterPortCheck>({});
  const [chain, setChain] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Bumped on every edit so a slow in-flight check can't paint a verdict for a value the
  // user has already changed.
  const portRun = useRef(0);

  const numbers = useMemo(
    () => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])) as Record<keyof Values, number>,
    [values],
  );

  const trimmedId = routerId.trim();
  const malformedId = trimmedId.length > 0 && !ROUTER_ID_PATTERN.test(trimmedId);
  const walletPasswordError = validateNewPassword(walletPassword, walletPasswordConfirm);

  useEffect(() => {
    void getSuggestedRouterPorts()
      .then((ports) => setValues((v) => ({ ...v, networkPort: String(ports.networkPort), rpcPort: String(ports.rpcPort) })))
      .catch((e) => setPortErrors({ networkPort: (e as { message?: string })?.message ?? "Could not find free ports." }));
    void checkBackend()
      .then((s) => setChain(s.chain ?? null))
      .catch(() => setChain(null));
  }, []);

  // Confirms Portal's own Tor is still up and picks up the ports it landed on, which the
  // cached defaults can only be stale about after a restart.
  useEffect(() => {
    void checkTor()
      .then((status) => {
        setTorError(status.reachable && status.authenticated ? null : (status.error ?? "Tor is unreachable."));
        if (status.socksPort === undefined || status.controlPort === undefined) return;
        setValues((v) => ({ ...v, socksPort: String(status.socksPort), controlPort: String(status.controlPort) }));
      })
      .catch((e) => setTorError((e as { message?: string })?.message ?? "Tor is unreachable."));
  }, []);

  useEffect(() => {
    const { networkPort, rpcPort } = numbers;
    if (![networkPort, rpcPort].every((p) => Number.isInteger(p) && p > 0)) return;
    const run = ++portRun.current;
    const timer = setTimeout(() => {
      void checkRouterPorts(networkPort, rpcPort)
        .then((result) => {
          if (run === portRun.current) setPortErrors(result);
        })
        .catch(() => {});
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [numbers.networkPort, numbers.rpcPort, numbers.socksPort, numbers.controlPort]);

  const config = useMemo<RouterInitConfig | null>(() => {
    if (!trimmedId || malformedId || walletPasswordError) return null;
    if (Object.values(numbers).some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (numbers.requiredConfirms < 1) return null;
    return {
      routerId: trimmedId,
      // A router's wallet is its own, so the id doubles as the wallet name unless overridden.
      walletName: walletName.trim() || trimmedId,
      dataDir: dataDir.trim() || undefined,
      walletPassword,
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
  }, [trimmedId, malformedId, walletName, dataDir, walletPassword, walletPasswordError, numbers]);

  const blocked = torError !== null || portErrors.networkPort !== undefined || portErrors.rpcPort !== undefined;

  // A disabled Create button with no explanation is the whole reason an empty password reads as
  // the form being broken. Names the first thing standing in the way, in form order.
  const blockedReason = !trimmedId
    ? "Enter a router ID to continue."
    : malformedId
      ? "Fix the router ID to continue."
      : walletPasswordError
        ? walletPasswordError
        : blocked
          ? "Resolve the warning above to continue."
          : !config
            ? "Check the values above to continue."
            : null;

  function set(key: keyof Values) {
    return (next: string) => setValues((v) => ({ ...v, [key]: next }));
  }

  async function createRouter() {
    if (!config) return;
    setCreating(true);
    try {
      await initRouter(config);
      setWalletPassword("");
      setWalletPasswordConfirm("");
      pushToast("success", `${config.routerId} was created and registered.`);
      navigate(`/router/${encodeURIComponent(config.routerId)}/setup`);
    } catch (error) {
      pushToast("error", (error as { message?: string })?.message ?? "Could not create router.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[640px] pb-8">
        <header className="mb-6">
          <Link to="/router" className="mb-4 inline-flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle hover:text-foreground">
            <ArrowLeft size={14} />
            Back to routers
          </Link>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-card bg-primary text-on-primary">
                <Server size={22} />
              </span>
              <div>
                <h1 className="font-header text-[29px] font-bold text-foreground">Add Router</h1>
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
              label="Router ID"
              placeholder="router-02"
              autoFocus
              required
              value={routerId}
              onChange={(e) => setRouterId(e.target.value)}
              error={malformedId ? "Letters, numbers, hyphens and underscores only." : undefined}
              hint={malformedId ? undefined : "Also names its wallet. Everything below is already set."}
            />
            <div className="mt-3">
              <Disclosure label="Wallet name and data directory">
                <div className="flex flex-col gap-3 pt-1">
                  <TextField label="Wallet name" placeholder={trimmedId || "Same as Router ID"} value={walletName} onChange={(e) => setWalletName(e.target.value)} />
                  <TextField label="Data directory" placeholder="Default router directory" value={dataDir} onChange={(e) => setDataDir(e.target.value)} />
                  <p className="text-[11.5px] leading-5 text-subtle">
                    Wallet name and data directory are permanent and cannot be changed later.
                  </p>
                </div>
              </Disclosure>
            </div>
            <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
              <PasswordField label="Wallet password" autoComplete="new-password" required value={walletPassword} onChange={(e) => setWalletPassword(e.target.value)} />
              <PasswordField
                label="Confirm wallet password"
                autoComplete="new-password"
                required
                value={walletPasswordConfirm}
                onChange={(e) => setWalletPasswordConfirm(e.target.value)}
                error={walletPassword || walletPasswordConfirm ? walletPasswordError : undefined}
              />
              <p className="text-[11.5px] leading-5 text-subtle">
                Portal encrypts every router wallet it creates. Losing this password can make its
                funds unrecoverable.
              </p>
            </div>
          </div>

          {group(
            "Tor",
            <>
              <SummaryRow label="SOCKS port" value={values.socksPort} readOnly hint="Portal runs its own Tor" />
              <SummaryRow label="Control port" value={values.controlPort} readOnly />
            </>,
            torError,
          )}

          {group(
            "Router ports",
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
            // The one group here that is not a default. Spelled out in days because nobody
            // converts blocks into time in their head while deciding what to lock up.
            `Unlike everything above, these two are fixed once the bond is created: ≈ ${timelockDays(
              Number(values.fidelityTimelock) || ROUTER_DEFAULTS.fidelityTimelock,
            )} days with the funds locked and unspendable. Editing them later applies only to the next bond, after this one expires.`,
          )}

          <div className="border-t border-line px-5 py-4">
            <p className="text-[11.5px] leading-5 text-subtle">
              Ports, fees and limits are defaults and can be changed later from the router's
              Settings tab. The fidelity bond cannot.
            </p>
          </div>
        </Card>

        <div className="mt-4 flex items-center justify-end gap-3">
          {blockedReason && <p className="text-[11.5px] text-subtle">{blockedReason}</p>}
          <LinkButton to="/router" variant="secondary">Cancel</LinkButton>
          <Button onClick={() => void createRouter()} loading={creating} disabled={!config || blocked}>
            Create router
          </Button>
        </div>
      </div>
    </div>
  );
}
