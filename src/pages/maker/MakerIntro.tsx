import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { checkTor, getSuggestedMakerPorts, initMaker } from "../../api/commands";
import { Card } from "../../components/ui/display";
import { Checklist, type CheckState } from "../../components/ui/Checklist";
import { Button, TextField } from "../../components/ui/inputs";
import { IntroStage } from "../../components/ui/IntroStage";
import { loadConnectivityDefaults } from "../../lib/connectivity";
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
 * Shown instead of the dashboard when no makers are registered: a name, and everything else
 * defaulted. Ports come from the same pre-flight the full form uses, and the economics from
 * `MAKER_DEFAULTS`, all of which a maker's Settings tab can change afterwards.
 */
export function MakerIntro({ onImported }: { onImported: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [stage, setStage] = useState<Stage>("name");
  const [steps, setSteps] = useState<Steps>(IDLE);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const malformed = trimmed.length > 0 && !MAKER_ID_PATTERN.test(trimmed);

  async function create() {
    if (!trimmed || malformed) return;
    const { torSocksPort, torControlPort, torAuthPassword } = loadConnectivityDefaults();
    setStage("creating");
    setError(null);
    setSteps({ ...IDLE, tor: "running" });

    try {
      await withMinDelay(
        (async () => {
          const status = await checkTor(torSocksPort, torControlPort, torAuthPassword);
          if (!(status.reachable && status.authenticated)) {
            throw new Error(status.error ?? "Tor control port unreachable.");
          }
        })(),
        MIN_STEP_MS,
      );
      setSteps((s) => ({ ...s, tor: "passed", ports: "running" }));

      const ports = await withMinDelay(getSuggestedMakerPorts(torSocksPort, torControlPort), MIN_STEP_MS);
      setSteps((s) => ({ ...s, ports: "passed", create: "running" }));

      await withMinDelay(
        initMaker({
          makerId: trimmed,
          // One name for both: a maker's wallet is its own, so a separate label would be
          // something else to invent and then keep straight.
          walletName: trimmed,
          socksPort: torSocksPort,
          controlPort: torControlPort,
          torAuthPassword: torAuthPassword || undefined,
          networkPort: ports.networkPort,
          rpcPort: ports.rpcPort,
          ...MAKER_DEFAULTS,
        }),
        MIN_STEP_MS,
      );
      setSteps((s) => ({ ...s, create: "passed" }));
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
    <IntroStage lead="OpenSwap" accent="Maker" caption="Create a new maker" className="min-h-full">
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
              </div>
              <div className="border-t border-line px-8 py-5">
                <Button
                  className="w-full"
                  disabled={!trimmed || malformed}
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
          Need to set ports, fees or a wallet password yourself?{" "}
          <Link to="/maker/new" className="text-primary hover:underline">
            Use the full form
          </Link>
        </p>
      </div>
    </IntroStage>
  );
}
