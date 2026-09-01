import { useEffect, useRef, useState } from "react";
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

/**
 * The first screen of every launch, ahead of the role picker, because a taker and a maker
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
  const [node, setNode] = useState<NodeBackend | null>(null);

  const [torProgress, setTorProgress] = useState<number | null>(null);
  const [torError, setTorError] = useState<string | null>(null);
  const [backendRows, setBackendRows] = useState<TestRow[] | null>(null);
  const [testing, setTesting] = useState(false);

  // Bootstrap runs once per launch; a re-mount must not start a second poll against it.
  const polling = useRef(false);
  // Bumped by Retry to re-arm the poll after it gave up.
  const [torAttempt, setTorAttempt] = useState(0);

  useEffect(() => {
    void getChainBackend()
      .then((config) => {
        setKind(config.kind);
        setElectrumUrl(config.electrum.url);
        // The view deliberately omits the password, so it has to be reinstated before this
        // object can be sent back as a config. Empty means "keep the session's own", which
        // is what `merge_preserved_password` fills in on the Rust side.
        setNode(config.node && { ...config.node, password: "" });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (polling.current) return;
    polling.current = true;
    let cancelled = false;
    void (async () => {
      const deadline = Date.now() + TOR_BOOTSTRAP_TIMEOUT_MS;
      for (;;) {
        if (cancelled) return;
        try {
          const status = await checkTor();
          if (!(status.reachable && status.authenticated)) {
            throw new Error(status.error ?? "Tor control port unreachable.");
          }
          setTorError(null);
          setTorProgress(status.bootstrapProgress ?? 0);
          if (status.bootstrapProgress === 100) return;
          if (Date.now() > deadline) {
            throw new Error("Tor started but could not finish connecting to the network.");
          }
        } catch (e) {
          // Giving up releases the guard so Retry can arm a fresh attempt; without that a
          // single transient failure would leave Next disabled for the whole session.
          setTorError((e as { message?: string })?.message ?? "Tor could not be started.");
          polling.current = false;
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
  const backendLabel = kind === "coreRpc" ? "Bitcoin Core" : "Electrum";

  function currentConfig(): ChainBackendConfig {
    return { kind, electrum: { url: electrumUrl.trim(), useTor: false }, node };
  }

  /** Resolves only when `config` answered a real chain query. */
  async function probe(config: ChainBackendConfig): Promise<boolean> {
    setTesting(true);
    try {
      const status = await checkBackend(config);
      setBackendRows([
        {
          label: backendLabel,
          ok: status.reachable,
          message: status.reachable
            ? `${status.chain ?? "connected"}${status.blocks !== undefined ? ` · block ${status.blocks.toLocaleString()}` : ""}`
            : (status.error ?? "No answer."),
        },
      ]);
      return status.reachable;
    } catch (e) {
      setBackendRows([
        {
          label: backendLabel,
          ok: false,
          // Falls through to the raw value: a rejection with no `message` is a plumbing
          // fault, and reporting it as an unreachable server sends the user hunting the
          // wrong thing.
          message: (e as { message?: string })?.message ?? String(e),
        },
      ]);
      return false;
    } finally {
      setTesting(false);
    }
  }

  async function next() {
    // One snapshot for both calls: re-probed rather than trusting an earlier pass, and the
    // config adopted below is the exact one that answered, even if the user edits a field
    // while the probe is in flight.
    const config = currentConfig();
    if (!(await probe(config))) return;
    try {
      // Adopting the config is what marks the gate satisfied, so a failure here has to be
      // shown: navigating anyway would bounce straight back and read as the page reloading
      // itself for no reason.
      await setChainBackend(config);
    } catch (e) {
      setBackendRows([
        {
          label: backendLabel,
          ok: false,
          message: (e as { message?: string })?.message ?? String(e),
        },
      ]);
      return;
    }
    setConnected();
    navigate("/launch", { replace: true });
  }

  function editNode(patch: Partial<NodeBackend>) {
    setNode((n) => (n ? { ...n, ...patch } : n));
    setBackendRows(null);
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
                  setBackendRows(null);
                }}
                options={[
                  { value: "electrum", label: "Electrum" },
                  { value: "coreRpc", label: "Bitcoin Core" },
                ]}
              />
            </div>

            {kind === "electrum" ? (
              <SummaryGroup title="Server">
                <SummaryRow
                  label="Server URL"
                  value={electrumUrl}
                  inputMode="text"
                  hint="The default works out of the box"
                  onCommit={(url) => {
                    setElectrumUrl(url);
                    setBackendRows(null);
                  }}
                />
              </SummaryGroup>
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

            <div>
              <Button size="sm" variant="secondary" loading={testing} onClick={() => void probe(currentConfig())}>
                Test connection
              </Button>
              {backendRows && <TestResultRows rows={backendRows} />}
            </div>
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
                  ok: torReady,
                  message: torError
                    ? torError
                    : torReady
                      ? "Bootstrap complete — Tor is ready"
                      : `Bootstrapping — ${torProgress ?? 0}%`,
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
          <Button disabled={!torReady} loading={testing} onClick={() => void next()}>
            Next
          </Button>
        </div>
      </div>
    </IntroStage>
  );
}
