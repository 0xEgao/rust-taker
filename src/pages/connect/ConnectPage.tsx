import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { checkBackend, checkTor, getChainBackend, setChainBackend } from "../../api/commands";
import type { ChainBackendConfig, ChainBackendKind, NodeBackend } from "../../api/types";
import {
  SettingsSection,
  TestResultRows,
  type TestRow,
} from "../../components/ui/display";
import {
  Button,
  CheckRow,
  PasswordField,
  SegmentedToggle,
  SummaryGroup,
  SummaryRow,
} from "../../components/ui/inputs";
import { IntroStage } from "../../components/ui/IntroStage";
import { wait } from "../../lib/timing";
import { useSessionStore } from "../../store/session";

// A Tor with no cached consensus needs roughly a minute; the ceiling is for one that is
// reaching the network but never converging, so the gate fails instead of hanging forever.
const TOR_BOOTSTRAP_TIMEOUT_MS = 180_000;
const TOR_POLL_MS = 1_200;
// Consecutive probe misses tolerated before the panel calls it a failure.
const TOR_MAX_CONSECUTIVE_FAILURES = 6;

/**
 * The first screen of every launch, ahead of the role picker, because a wallet and a router
 * both need the same two things before they can do anything: a chain backend that answers,
 * and a bootstrapped Tor.
 *
 * Nothing entered here is written to disk. The fields arrive prefilled from Rust and an edit
 * lasts for the session, which is why a node's RPC password never ends up at rest.
 */
export function ConnectPage() {
  const navigate = useNavigate();
  const setConnected = useSessionStore((s) => s.setConnected);

  const [kind, setKind] = useState<ChainBackendKind>("electrum");
  const [electrumUrl, setElectrumUrl] = useState("");
  const [electrumUseTor, setElectrumUseTor] = useState(false);
  const [node, setNode] = useState<NodeBackend | null>(null);

  const [torProgress, setTorProgress] = useState<number | null>(null);
  const [torError, setTorError] = useState<string | null>(null);
  // Null means nothing has been checked for the config on screen — which is what puts the
  // Test button back. Starts pending because the arrival probe below is already on its way,
  // and a button that appears for one frame and then vanishes reads as a glitch.
  const [backendRow, setBackendRow] = useState<TestRow | null>({
    label: "Electrum",
    state: "pending",
    message: "Checking…",
  });
  const [advancing, setAdvancing] = useState(false);
  // The config a probe last passed against, as a snapshot: comparing it to the current one
  // tells Next whether a fresh probe would learn anything, without tracking which field changed.
  const [verified, setVerified] = useState<string | null>(null);

  // Bumped by Retry to re-arm the poll after it gave up.
  const [torAttempt, setTorAttempt] = useState(0);

  useEffect(() => {
    void getChainBackend()
      .then((config) => {
        setKind(config.kind);
        setElectrumUrl(config.electrum.url);
        setElectrumUseTor(config.electrum.useTor);
        // The view deliberately omits the password, so it has to be reinstated before this
        // object can be sent back as a config. Empty means "keep the session's own", which
        // is what `merge_preserved_password` fills in on the Rust side.
        const node = config.node && { ...config.node, password: "" };
        setNode(node);
        // Probed on arrival because Tor takes a minute or more to bootstrap and this takes a
        // second: by the time Next unlocks the answer is already in, so pressing it doesn't
        // re-run a check the user has been looking at the result of.
        return probe({
          kind: config.kind,
          electrum: { url: config.electrum.url.trim(), useTor: config.electrum.useTor },
          node,
        });
      })
      // Without a config there is nothing to probe, so hand the user the button instead of
      // leaving the row pending forever.
      .catch(() => setBackendRow(null));
  }, []);

  // No re-entrancy latch: a `useRef` guard survives StrictMode's double-invoke while the run
  // it guarded does not, so the second run finds it set and never polls. The closure flag is
  // enough, since the effect only re-runs when `torAttempt` changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const deadline = Date.now() + TOR_BOOTSTRAP_TIMEOUT_MS;
      // A probe that misses is not a Tor that failed: checkTor re-runs the full readiness wait
      // on every call, so a single miss against a busy, still-bootstrapping Tor is routine.
      let consecutiveFailures = 0;
      for (;;) {
        if (cancelled) return;
        try {
          const status = await checkTor();
          if (cancelled) return;
          if (!(status.reachable && status.authenticated)) {
            throw new Error(status.error ?? "Tor control port unreachable.");
          }
          consecutiveFailures = 0;
          setTorError(null);
          setTorProgress(status.bootstrapProgress ?? 0);
          if (status.bootstrapProgress === 100) return;
          if (Date.now() > deadline) {
            throw new Error("Tor started but could not finish connecting to the network.");
          }
        } catch (e) {
          if (cancelled) return;
          consecutiveFailures += 1;
          const givingUp =
            consecutiveFailures >= TOR_MAX_CONSECUTIVE_FAILURES || Date.now() > deadline;
          if (!givingUp) {
            await wait(TOR_POLL_MS);
            continue;
          }
          setTorError((e as { message?: string })?.message ?? "Tor could not be started.");
          return;
        }
        await wait(TOR_POLL_MS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [torAttempt]);

  const torReady = torProgress === 100;

  // Rust forces Tor for an onion host whatever the flag says, so the toggle follows rather than
  // contradicts it — a control that disagrees with the transport actually used is worse than none.
  const electrumHost = electrumUrl.trim().split("://").pop() ?? "";
  const onionElectrum = electrumHost.split(":")[0].endsWith(".onion");
  const torForced = onionElectrum;

  function currentConfig(): ChainBackendConfig {
    return {
      kind,
      electrum: { url: electrumUrl.trim(), useTor: torForced || electrumUseTor },
      node,
    };
  }

  /** Resolves only when `config` answered a real chain query. */
  async function probe(config: ChainBackendConfig): Promise<boolean> {
    // From the config under test, not from render state: the arrival probe runs before the
    // prefill has been committed to it.
    const label = config.kind === "coreRpc" ? "Bitcoin Core" : "Electrum";
    setBackendRow({ label, state: "pending", message: "Checking…" });
    try {
      const status = await checkBackend(config);
      setBackendRow({
        label,
        state: status.reachable ? "ok" : "failed",
        message: status.reachable
          ? `${status.chain ?? "connected"}${status.blocks !== undefined ? ` · block ${status.blocks.toLocaleString()}` : ""}`
          : (status.error ?? "No answer."),
      });
      setVerified(status.reachable ? JSON.stringify(config) : null);
      return status.reachable;
    } catch (e) {
      setBackendRow({
        label,
        state: "failed",
        // Falls through to the raw value: a rejection with no `message` is a plumbing
        // fault, and reporting it as an unreachable server sends the user hunting the
        // wrong thing.
        message: (e as { message?: string })?.message ?? String(e),
      });
      setVerified(null);
      return false;
    }
  }

  async function next() {
    // One snapshot throughout: the config adopted below is the exact one that answered, even
    // if the user edits a field while a probe is in flight.
    const config = currentConfig();
    setAdvancing(true);
    try {
      // A pass already stands for this exact config — the green row on screen is that answer,
      // so probing again would only make Next slower than the check it repeats.
      if (JSON.stringify(config) !== verified && !(await probe(config))) return;
      // Adopting the config is what marks the gate satisfied, so a failure here has to be
      // shown: navigating anyway would bounce straight back and read as the page reloading
      // itself for no reason.
      await setChainBackend(config);
      setConnected();
      navigate("/launch", { replace: true });
    } catch (e) {
      setBackendRow({
        label: config.kind === "coreRpc" ? "Bitcoin Core" : "Electrum",
        state: "failed",
        message: (e as { message?: string })?.message ?? String(e),
      });
    } finally {
      setAdvancing(false);
    }
  }

  // An edit retires the standing pass and the result reporting it, which is what brings the
  // Test button back: nothing on screen describes the config the user now has.
  function invalidate() {
    setBackendRow(null);
    setVerified(null);
  }

  function editNode(patch: Partial<NodeBackend>) {
    setNode((n) => (n ? { ...n, ...patch } : n));
    invalidate();
  }

  return (
    <IntroStage
      lead="Let's get you"
      accent="connected."
      caption="Pick where Portal reads the chain from. Tor starts on its own and carries every swap."
      className="min-h-screen"
    >
      <div className="mx-auto w-full max-w-4xl text-left">
        <div className="grid gap-4 md:grid-cols-2">
          <SettingsSection
            title="Choose your backend"
            subtitle="An Electrum server, or a Bitcoin Core node you run yourself"
            bodyClassName="flex flex-col gap-4 p-5"
          >
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                Backend
              </label>
              <SegmentedToggle
                groupId="chain-backend"
                value={kind}
                onChange={(next) => {
                  setKind(next);
                  invalidate();
                }}
                options={[
                  { value: "electrum", label: "Electrum" },
                  { value: "coreRpc", label: "Bitcoin Core" },
                ]}
              />
            </div>

            {kind === "electrum" ? (
              <>
                <SummaryGroup title="Server">
                  <SummaryRow
                    label="Server URL"
                    value={electrumUrl}
                    inputMode="text"
                    hint="The default works out of the box"
                    onCommit={(url) => {
                      setElectrumUrl(url);
                      invalidate();
                    }}
                  />
                </SummaryGroup>
                <CheckRow
                  checked={torForced || electrumUseTor}
                  onToggle={(next) => {
                    if (torForced) return;
                    setElectrumUseTor(next);
                    invalidate();
                  }}
                  primary="Reach this server over Tor"
                  secondary={
                    torForced
                      ? "Always on for an onion address"
                      : "Hides which server you ask, and costs some speed"
                  }
                />
                <p className="text-[11.5px] leading-5 text-subtle">
                  Off by default so the chain stays readable even when Tor is slow to bootstrap.
                  Swap traffic always goes over Tor either way.
                </p>
              </>
            ) : (
              node && (
                <>
                  <SummaryGroup title="Node connection">
                    <SummaryRow
                      label="RPC Host"
                      value={node.host}
                      inputMode="text"
                      onCommit={(host) => editNode({ host })}
                    />
                    <SummaryRow
                      label="RPC Port"
                      value={String(node.port)}
                      onCommit={(port) => editNode({ port: Number(port) || node.port })}
                    />
                    <SummaryRow
                      label="RPC Username"
                      value={node.username}
                      inputMode="text"
                      onCommit={(username) => editNode({ username })}
                    />
                    <SummaryRow
                      label="ZMQ Port"
                      value={String(node.zmqPort)}
                      onCommit={(zmqPort) => editNode({ zmqPort: Number(zmqPort) || node.zmqPort })}
                    />
                  </SummaryGroup>
                  <PasswordField
                    label="RPC Password"
                    placeholder={
                      node.passwordConfigured
                        ? "Portal's default (enter to replace)"
                        : "Enter RPC password"
                    }
                    autoComplete="current-password"
                    value={node.password}
                    onChange={(e) => editNode({ password: e.target.value })}
                  />
                </>
              )
            )}

            {/* A result and the button that produces it are the same control in two states,
                never both: the check runs on its own until an edit leaves nothing to report. */}
            {backendRow && <TestResultRows rows={[backendRow]} />}
            {(backendRow === null || backendRow.state === "failed") && (
              <div>
                <Button size="sm" variant="secondary" onClick={() => void probe(currentConfig())}>
                  {backendRow ? "Try again" : "Test connection"}
                </Button>
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            title="Tor connection"
            subtitle="Portal's own Tor, started fresh for this session"
            bodyClassName="flex flex-col gap-4 p-5"
          >
            <p className="text-[12px] leading-5 text-muted">
              Tor routes all swap traffic, so your IP and coin history stay private. Portal
              never touches a Tor already running on this machine. Next unlocks once it has
              fully bootstrapped.
            </p>
            <TestResultRows
              rows={[
                {
                  label: "Tor",
                  state: torError ? "failed" : torReady ? "ok" : "pending",
                  message: torError
                    ? torError
                    : torReady
                      ? "Bootstrap complete — Tor is ready"
                      : torProgress === null
                        ? "Starting…"
                        : `Bootstrapping — ${torProgress}%`,
                },
              ]}
            />
            {torError && (
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setTorError(null);
                    setTorProgress(null);
                    setTorAttempt((n) => n + 1);
                  }}
                >
                  Retry
                </Button>
              </div>
            )}
          </SettingsSection>
        </div>

        <div className="mt-4 flex items-center justify-end gap-3">
          {!torReady && !torError && (
            <span className="text-[12px] text-muted">Waiting for Tor to finish…</span>
          )}
          <Button disabled={!torReady} loading={advancing} onClick={() => void next()}>
            Next
          </Button>
        </div>
      </div>
    </IntroStage>
  );
}
