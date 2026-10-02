import { ArrowLeft, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { checkBackend, getRouterLogs, initRouter } from "../../api/commands";
import { Card } from "../../components/ui/display";
import { Button, LinkButton, TextField } from "../../components/ui/inputs";
import { useToastStore } from "../../store/toast";
import {
  AdvancedFields,
  BondFeeRateField,
  FidelityFields,
  PublicNameField,
  RouterPasswordFields,
  RouterRestoreChoice,
  useRouterForm,
  useRouterWallet,
} from "./RouterForm";
import { ROUTER_ID_PATTERN } from "./router-defaults";
import { RestoreProgress } from "../../components/app/RestoreProgress";

/** Adding a router to a fleet that already has one. Same form as the first-run page, with the
 *  dashboard's chrome around it instead of the intro's. */
export function AddRouterPage() {
  const navigate = useNavigate();
  const pushToast = useToastStore((state) => state.push);
  const form = useRouterForm();

  const [routerId, setRouterId] = useState("");
  const wallet = useRouterWallet();
  const [chain, setChain] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const trimmedId = routerId.trim();
  const restoreLog = useCallback(() => getRouterLogs(trimmedId, 200), [trimmedId]);
  const malformedId = trimmedId.length > 0 && !ROUTER_ID_PATTERN.test(trimmedId);
  const walletPasswordError = wallet.error;

  useEffect(() => {
    void checkBackend()
      .then((s) => setChain(s.chain ?? null))
      .catch(() => setChain(null));
  }, []);

  const config = useMemo(
    () =>
      !trimmedId || malformedId || walletPasswordError
        ? null
        : wallet.fields(form.config(trimmedId, wallet.password)),
    [trimmedId, malformedId, walletPasswordError, form, wallet],
  );

  // A disabled Create button with no explanation is the whole reason an empty password reads as
  // the form being broken. Names the first thing standing in the way, in form order.
  const blockedReason = !trimmedId
    ? "Enter a router ID to continue."
    : malformedId
      ? "Fix the router ID to continue."
      : form.publicNameError
        ? "Fix the public name to continue."
        : walletPasswordError
        ? walletPasswordError
        : form.blocked
          ? form.configError ? "Fix the fidelity bond values to continue." : "Resolve the warning under Advanced settings to continue."
          : !config
            ? "Check the values above to continue."
            : null;

  async function createRouter() {
    if (!config) return;
    setCreating(true);
    try {
      await initRouter(config);
      wallet.clear();
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

        {creating && config?.restoreSelection && (
          <Card className="mb-4 border-line-strong p-5">
            <h2 className="mb-4 font-header text-[14px] font-bold text-foreground">Restoring {config.routerId}</h2>
            <RestoreProgress
              load={restoreLog}
              finalStep="Registering the router"
              note={"This might take several minutes. You can leave this page and come back: the restore keeps running, and the router appears in your router list, ready to start, when it is done."}
            />
          </Card>
        )}
        <Card className="border-line-strong">
          <div className="p-5">
            <div className="mb-4 border-b border-line pb-4">
              <RouterRestoreChoice wallet={wallet} />
            </div>
            <TextField
              label="Router ID"
              placeholder="router-02"
              autoComplete="username"
              autoFocus
              required
              value={routerId}
              onChange={(e) => setRouterId(e.target.value)}
              error={malformedId ? "Letters, numbers, hyphens and underscores only." : undefined}
              hint={malformedId ? undefined : "Names its folder and wallet on this machine. Cannot be changed."}
            />
            <div className="mt-4">
              <PublicNameField form={form} routerId={trimmedId} />
            </div>
            <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
              <RouterPasswordFields wallet={wallet} />
            </div>
            <div className="mt-5 flex flex-col gap-4 border-t border-line pt-5">
              <FidelityFields form={form} />
              <BondFeeRateField form={form} />
              <AdvancedFields form={form} routerId={trimmedId} />
            </div>
          </div>

          <div className="border-t border-line px-5 py-4">
            <p className="text-[11.5px] leading-5 text-subtle">
              Ports, fees and limits can be changed later from the router's Settings tab. The
              fidelity bond is different: this bond keeps the amount and timelock set here, and
              edits apply to the next one.
            </p>
          </div>
        </Card>

        <div className="mt-4 flex items-center justify-end gap-3">
          {blockedReason && <p className="text-[11.5px] text-subtle">{blockedReason}</p>}
          <LinkButton to="/router" variant="secondary">Cancel</LinkButton>
          <Button onClick={() => void createRouter()} loading={creating} disabled={!config || form.blocked}>
            Create router
          </Button>
        </div>
      </div>
    </div>
  );
}
