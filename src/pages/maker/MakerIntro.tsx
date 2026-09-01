import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { checkTor, getSuggestedMakerPorts, initMaker } from "../../api/commands";
import { Card } from "../../components/ui/display";
import { Checklist, type CheckState } from "../../components/ui/Checklist";
import { Button, PasswordField, TextField } from "../../components/ui/inputs";
import { validateNewPassword } from "../../lib/password-policy";
import { withMinDelay } from "../../lib/timing";
import { MAKER_DEFAULTS, MAKER_ID_PATTERN } from "./maker-defaults";
import { DashboardImport } from "./DashboardImport";

// Each step usually resolves far quicker than it can be read.
const MIN_STEP_MS = 900;

type Stage = "name" | "creating";

interface Steps {
  tor: CheckState;
  ports: CheckState;
  create: CheckState;
}

const IDLE: Steps = { tor: "idle", ports: "idle", create: "idle" };

/**
 * Shown instead of the dashboard when no makers are registered: a name and a wallet password,
 * with everything else defaulted. Ports come from the same pre-flight the full form uses, and
 * the economics from `MAKER_DEFAULTS`, all of which a maker's Settings tab can change
 * afterwards.
 */
export function MakerIntro({ onImported }: { onImported: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [stage, setStage] = useState<Stage>("name");
  const [steps, setSteps] = useState<Steps>(IDLE);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const malformed = trimmed.length > 0 && !MAKER_ID_PATTERN.test(trimmed);
  const passwordError = validateNewPassword(password, passwordConfirm);

  async function create() {
    if (!trimmed || malformed || passwordError) return;
    setStage("creating");
    setError(null);
    setSteps({ ...IDLE, tor: "running" });

    // Sent straight back to init_maker, which overrides them from Portal's own Tor anyway;
    // the maker settings still carry the pair until that sweep lands.
    let torPorts = { socksPort: 0, controlPort: 0 };
    try {
      await withMinDelay(
        (async () => {
          const status = await checkTor();
          if (!(status.reachable && status.authenticated)) {
            throw new Error(status.error ?? "Tor control port unreachable.");
          }
          torPorts = { socksPort: status.socksPort ?? 0, controlPort: status.controlPort ?? 0 };
        })(),
        MIN_STEP_MS,
      );
      setSteps((s) => ({ ...s, tor: "passed", ports: "running" }));

      const ports = await withMinDelay(
        getSuggestedMakerPorts(),
        MIN_STEP_MS,
      );
      setSteps((s) => ({ ...s, ports: "passed", create: "running" }));

      await withMinDelay(
        initMaker({
          makerId: trimmed,
          // One name for both: a maker's wallet is its own, so a separate label would be
          // something else to invent and then keep straight.
          walletName: trimmed,
          walletPassword: password,
          ...torPorts,
          networkPort: ports.networkPort,
          rpcPort: ports.rpcPort,
          ...MAKER_DEFAULTS,
        }),
        MIN_STEP_MS,
      );
      setSteps((s) => ({ ...s, create: "passed" }));
      setPassword("");
      setPasswordConfirm("");
      // Created but not yet bonded: setup starts it and walks the deposit.
      navigate(`/maker/${encodeURIComponent(trimmed)}/setup`);
    } catch (e) {
      setSteps((s) => ({
        tor: s.tor === "running" ? "failed" : s.tor,
        ports: s.ports === "running" ? "failed" : s.ports,
        create: s.create === "running" ? "failed" : s.create,
      }));
      setError((e as { message?: string })?.message ?? "Could not create the maker.");
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg">
      <Card className="border-line-strong">
        {stage === "name" ? (
          <>
            <div className="p-8 text-left">
              <TextField
                label="Maker name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void create()}
                placeholder="my-maker"
                autoFocus
                error={malformed ? "Letters, numbers, hyphens and underscores only." : undefined}
                hint={malformed ? undefined : "Names the maker and its wallet. Everything else can change later."}
              />
              <div className="mt-4 flex flex-col gap-3">
                <PasswordField
                  label="Wallet password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <PasswordField
                  label="Confirm wallet password"
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  error={password || passwordConfirm ? passwordError : undefined}
                />
                <p className="text-[11.5px] leading-5 text-subtle">
                  Portal encrypts every maker wallet it creates. This password cannot be recovered
                  if it is lost.
                </p>
              </div>
            </div>
            <div className="border-t border-line px-8 py-5">
              <Button
                className="w-full"
                disabled={!trimmed || malformed || Boolean(passwordError)}
                onClick={() => void create()}
              >
                Create maker
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="p-8 text-left">
              <Checklist
                steps={[
                  { label: "Checking Tor", state: steps.tor },
                  { label: "Reserving ports", state: steps.ports },
                  { label: `Creating ${trimmed}`, state: steps.create },
                ]}
              />
            </div>
            {error && (
              <div className="border-t border-line px-8 py-5 text-left">
                <p className="text-[12.5px] text-danger">{error}</p>
                <div className="mt-4 flex gap-3">
                  <Button variant="secondary" onClick={() => { setStage("name"); setSteps(IDLE); setError(null); }}>
                    Change name
                  </Button>
                  <Button className="flex-1" onClick={() => void create()}>
                    Retry
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="mt-4">
        <DashboardImport onImported={onImported} />
      </div>

      <p className="mt-4 text-[11.5px] text-subtle">
        Need to set ports, fees, or storage yourself?{" "}
        <Link to="/maker/new" className="text-primary hover:underline">
          Use the full form
        </Link>
      </p>
    </div>
  );
}
