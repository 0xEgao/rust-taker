import { ArrowLeft, CheckCircle2, Circle, LoaderCircle, Server, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { checkTor, getSuggestedMakerPorts, initMaker } from "../../api/commands";
import type { MakerInitConfig } from "../../api/types";
import { Card } from "../../components/ui/display";
import { Button, PasswordField, TextField } from "../../components/ui/inputs";
import { useToastStore } from "../../store/toast";

type CheckState = "idle" | "running" | "passed" | "failed";

const DEFAULTS = {
  socksPort: "9050",
  controlPort: "9051",
  networkPort: "6102",
  rpcPort: "6103",
  minSwapAmount: "100000",
  fidelityAmount: "100000",
  fidelityTimelock: "15000",
  requiredConfirms: "1",
  baseFee: "1000",
  amountRelativeFeePct: "0.025",
  timeRelativeFeePct: "0.001",
};

function Section({ title, subtitle, children, className = "" }: { title: string; subtitle: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={`border-line-strong ${className}`}>
      <div className="border-b border-line px-5 py-4"><h2 className="font-header text-[15px] font-bold text-foreground">{title}</h2><p className="mt-1 text-[12px] text-muted">{subtitle}</p></div>
      <div className="grid grid-cols-2 gap-4 p-5 max-[700px]:grid-cols-1">{children}</div>
    </Card>
  );
}

function CheckRow({ label, detail, state }: { label: string; detail: string; state: CheckState }) {
  const icon = state === "running" ? <LoaderCircle size={17} className="animate-spin text-warning" /> : state === "passed" ? <CheckCircle2 size={17} className="text-success" /> : <Circle size={17} className={state === "failed" ? "text-danger" : "text-subtle"} />;
  return <div className="flex items-center gap-3 border-t border-line px-5 py-4 first:border-0">{icon}<div><strong className="block text-[12.5px] text-foreground">{label}</strong><span className={`mt-0.5 block text-[11px] ${state === "failed" ? "text-danger" : "text-subtle"}`}>{detail}</span></div></div>;
}

export function AddMakerPage() {
  const navigate = useNavigate();
  const pushToast = useToastStore((state) => state.push);
  const [form, setForm] = useState({ makerId: "", walletName: "", dataDir: "", walletPassword: "", torAuthPassword: "", ...DEFAULTS });
  const [torCheck, setTorCheck] = useState<CheckState>("idle");
  const [portCheck, setPortCheck] = useState<CheckState>("idle");
  const [torDetail, setTorDetail] = useState("Not checked yet");
  const [portDetail, setPortDetail] = useState("Suggested unique ports will be verified");
  const [creating, setCreating] = useState(false);

  const socksPort = Number(form.socksPort);
  const controlPort = Number(form.controlPort);

  useEffect(() => {
    if (!Number.isInteger(socksPort) || !Number.isInteger(controlPort)) return;
    setPortCheck("running");
    void getSuggestedMakerPorts(socksPort, controlPort).then((ports) => {
      setForm((current) => ({ ...current, networkPort: String(ports.networkPort), rpcPort: String(ports.rpcPort) }));
      setPortCheck("passed");
      setPortDetail(`Reserved suggestion: ${ports.networkPort} / ${ports.rpcPort}`);
    }).catch((error) => {
      setPortCheck("failed");
      setPortDetail((error as { message?: string })?.message ?? "Could not find unique maker ports");
    });
  }, [socksPort, controlPort]);

  const config = useMemo<MakerInitConfig | null>(() => {
    const numeric = {
      networkPort: Number(form.networkPort), rpcPort: Number(form.rpcPort), socksPort: Number(form.socksPort), controlPort: Number(form.controlPort),
      minSwapAmount: Number(form.minSwapAmount), fidelityAmount: Number(form.fidelityAmount), fidelityTimelock: Number(form.fidelityTimelock),
      requiredConfirms: Number(form.requiredConfirms), baseFee: Number(form.baseFee), amountRelativeFeePct: Number(form.amountRelativeFeePct), timeRelativeFeePct: Number(form.timeRelativeFeePct),
    };
    if (!form.makerId.trim() || !form.walletName.trim() || Object.values(numeric).some((value) => !Number.isFinite(value) || value < 0)) return null;
    return { makerId: form.makerId.trim(), walletName: form.walletName.trim(), walletPassword: form.walletPassword || undefined, torAuthPassword: form.torAuthPassword || undefined, dataDir: form.dataDir.trim() || undefined, ...numeric };
  }, [form]);

  function field(name: keyof typeof form) { return { value: form[name], onChange: (event: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [name]: event.target.value })) }; }

  async function testTor() {
    setTorCheck("running"); setTorDetail("Connecting and checking bootstrap status…");
    try {
      const status = await checkTor(socksPort, controlPort, form.torAuthPassword);
      if (!status.reachable || !status.authenticated) throw new Error(status.error ?? "Tor control authentication failed");
      setTorCheck("passed"); setTorDetail(`Ready via ${status.source ?? "Tor"}${status.bootstrapProgress === undefined ? "" : ` · ${status.bootstrapProgress}% bootstrapped`}`);
    } catch (error) { setTorCheck("failed"); setTorDetail((error as { message?: string })?.message ?? "Tor is unavailable"); }
  }

  async function createMaker() {
    if (!config) return;
    setCreating(true);
    try {
      await initMaker(config);
      pushToast("success", `${config.makerId} was created and registered.`);
      navigate(`/maker/${encodeURIComponent(config.makerId)}`);
    } catch (error) { pushToast("error", (error as { message?: string })?.message ?? "Could not create maker."); }
    finally { setCreating(false); }
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[1180px] pb-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div><Link to="/maker" className="mb-4 inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-subtle hover:text-foreground"><ArrowLeft size={14} />Back to makers</Link><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-lg bg-primary text-white"><Server size={22} /></span><div><h1 className="font-header text-[29px] font-bold text-foreground">Add Maker</h1><p className="mt-1 text-[12.5px] text-muted">Create a stopped maker wallet, then start it when you are ready.</p></div></div></div>
          <span className="rounded-pill border border-primary/35 bg-primary/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-primary">Signet</span>
        </header>

        <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          <Section title="Basic information" subtitle="Stable identity and local wallet storage" className="col-span-2 max-[900px]:col-span-1">
            <TextField label="Maker ID" placeholder="maker-01" hint="Letters, numbers, underscores and hyphens." {...field("makerId")} />
            <TextField label="Wallet name" placeholder="maker-wallet" {...field("walletName")} />
            <TextField label="Data directory (optional)" placeholder="Default maker directory" {...field("dataDir")} />
            <PasswordField label="Wallet password (optional)" autoComplete="new-password" {...field("walletPassword")} />
          </Section>

          <Section title="Tor configuration" subtitle="Shared Tor SOCKS and control service">
            <TextField label="SOCKS port" inputMode="numeric" {...field("socksPort")} />
            <TextField label="Control port" inputMode="numeric" {...field("controlPort")} />
            <div className="col-span-2 max-[700px]:col-span-1"><PasswordField label="Tor control password (optional)" {...field("torAuthPassword")} /></div>
          </Section>
          <Section title="Maker ports" subtitle="Unique listeners for this maker instance">
            <TextField label="Network port" inputMode="numeric" {...field("networkPort")} />
            <TextField label="Maker RPC port" inputMode="numeric" {...field("rpcPort")} />
            <div className="col-span-2 max-[700px]:col-span-1"><TextField label="Required confirmations" inputMode="numeric" {...field("requiredConfirms")} /></div>
          </Section>

          <Section title="Swap policy" subtitle="Minimum size and fees advertised to takers">
            <TextField label="Minimum swap amount (sats)" inputMode="numeric" {...field("minSwapAmount")} />
            <TextField label="Base fee (sats)" inputMode="numeric" {...field("baseFee")} />
            <TextField label="Amount-relative fee (%)" inputMode="decimal" {...field("amountRelativeFeePct")} />
            <TextField label="Time-relative fee (%)" inputMode="decimal" {...field("timeRelativeFeePct")} />
          </Section>
          <Section title="Fidelity bond" subtitle="Reputation collateral and lock duration">
            <TextField label="Target amount (sats)" inputMode="numeric" {...field("fidelityAmount")} />
            <TextField label="Timelock (blocks)" inputMode="numeric" {...field("fidelityTimelock")} />
            <div className="col-span-2 max-[700px]:col-span-1 rounded-control border border-line bg-surface/60 p-3 text-[11.5px] leading-5 text-muted"><ShieldCheck size={16} className="mb-2 text-warning" />Fidelity funds are time-locked. Review these values carefully before funding the maker wallet.</div>
          </Section>

          <Card className="col-span-2 border-line-strong max-[900px]:col-span-1">
            <div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="font-header text-[15px] font-bold">Preflight</h2><p className="mt-1 text-[12px] text-muted">Check shared services before creating the wallet.</p></div><Button variant="secondary" size="sm" onClick={() => void testTor()} loading={torCheck === "running"}>Test Tor</Button></div>
            <CheckRow label="Unique maker ports" detail={portDetail} state={portCheck} />
            <CheckRow label="Tor SOCKS and control" detail={torDetail} state={torCheck} />
          </Card>
        </div>

        <div className="mt-5 flex items-center justify-between gap-4 rounded-card border border-line-strong bg-surface-raised/70 p-4"><p className="text-[11.5px] text-muted">Creation writes the wallet and registration, but leaves the maker stopped.</p><div className="flex gap-2"><Link to="/maker" className="inline-flex h-10 items-center rounded-control border border-line px-5 text-[13px] font-semibold text-foreground">Cancel</Link><Button onClick={() => void createMaker()} loading={creating} disabled={!config || portCheck !== "passed" || torCheck !== "passed"}>Create maker</Button></div></div>
      </div>
    </div>
  );
}
