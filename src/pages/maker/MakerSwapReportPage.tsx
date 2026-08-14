import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getMakerSwapReport, verifyMakerDeniability } from "../../api/commands";
import type { MakerSwapReportDetail } from "../../api/types";
import {
  BackButton,
  Card,
  Disclosure,
  EmptyState,
  ExternalLinkButton,
  MicroLabel,
  SatsAmount,
  SkeletonLines,
} from "../../components/ui/display";
import { Button } from "../../components/ui/inputs";
import { formatDuration, formatRelativeTime } from "../../lib/wallet-format";
import { useToastStore } from "../../store/toast";

function Artifact({
  label,
  txid,
  direction,
}: {
  label: string;
  txid: string;
  direction: "incoming" | "outgoing";
}) {
  return (
    <div className="flex items-center gap-4 rounded-control border border-line bg-surface/70 p-4">
      <span
        className={`grid h-10 w-10 place-items-center rounded-control ${
          direction === "incoming"
            ? "bg-success/10 text-success"
            : "bg-warning/10 text-warning"
        }`}
      >
        {direction === "incoming" ? (
          <ArrowDownLeft size={19} />
        ) : (
          <ArrowUpRight size={19} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <MicroLabel>{label}</MicroLabel>
        <code className="mt-1 block truncate font-mono text-[11px]" title={txid}>
          {txid}
        </code>
      </div>
      <ExternalLinkButton txid={txid} />
    </div>
  );
}

export function MakerSwapReportPage() {
  const { makerId = "", swapId = "" } = useParams();
  const id = decodeURIComponent(makerId);
  const reportId = decodeURIComponent(swapId);
  const pushToast = useToastStore((s) => s.push);
  const [report, setReport] = useState<MakerSwapReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);
  useEffect(() => {
    void getMakerSwapReport(id, reportId)
      .then(setReport)
      .catch((e) => pushToast("error", e.message))
      .finally(() => setLoading(false));
  }, [id, reportId, pushToast]);
  if (loading)
    return (
      <div className="mx-auto w-full max-w-xl pt-20"><SkeletonLines count={8} /></div>
    );
  if (!report)
    return (
      <EmptyState size="lg" title="Report unavailable" description="The maker report could not be loaded." />
    );
  const spread = report.incomingAmountSats - report.outgoingAmountSats;
  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-[1250px] pb-8">
        <header className="flex items-center gap-3">
          <BackButton to={`/maker/${encodeURIComponent(id)}`} label="Back to maker" />
          <div>
            <h1 className="font-header text-[26px] font-bold">
              Maker swap report
            </h1>
            <p className="mt-1 font-mono text-[10.5px] text-subtle">
              {report.network} · {formatRelativeTime(report.endTimestamp)} ·{" "}
              {report.status}
            </p>
          </div>
        </header>
        <div className="mt-6 grid grid-cols-[minmax(0,1fr)_340px] gap-4 max-[900px]:grid-cols-1">
          <main className="space-y-4">
            <Card glow className="border-line-strong p-6">
              <MicroLabel>Fee earned</MicroLabel>
              <strong className="mt-3 block font-numeric text-[38px] text-success">
                +<SatsAmount sats={report.feeEarnedSats} glyphScale={0.5} />
              </strong>
              <p
                className="mt-2 truncate font-mono text-[10px] text-muted"
                title={report.swapId}
              >
                Swap {report.swapId}
              </p>
            </Card>
            <Card className="border-line-strong">
              <div className="border-b border-line px-5 py-4">
                <h2 className="font-header text-[14px] font-bold">
                  Transaction artifacts
                </h2>
              </div>
              <div className="space-y-3 p-5">
                <Artifact
                  label="Incoming contract"
                  txid={report.incomingContractTxid}
                  direction="incoming"
                />
                <Artifact
                  label="Outgoing contract"
                  txid={report.outgoingContractTxid}
                  direction="outgoing"
                />
              </div>
            </Card>
            <Card className="border-line-strong">
              <div className="border-b border-line px-5 py-4">
                <h2 className="font-header text-[14px] font-bold">
                  Maker flow
                </h2>
              </div>
              <div className="grid grid-cols-3 gap-px bg-line max-[650px]:grid-cols-1">
                {[
                  ["Incoming", report.incomingAmountSats, "text-success"],
                  ["Outgoing", report.outgoingAmountSats, "text-warning"],
                  [
                    "Earned spread",
                    spread,
                    spread >= 0 ? "text-success" : "text-danger",
                  ],
                ].map(([label, value, tone]) => (
                  <div key={String(label)} className="bg-surface/80 p-5">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
                      {label}
                    </span>
                    <strong
                      className={`mt-2 block font-mono text-[16px] ${tone}`}
                    >
                      <SatsAmount sats={Number(value)} />
                    </strong>
                  </div>
                ))}
              </div>
            </Card>
            <Card className="border-line-strong p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-header text-[14px] font-bold">
                    Deniability proof
                  </h2>
                  <p className="mt-1 text-[11px] text-muted">
                    Verify the report proof against the maker wallet and chain
                    state.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  loading={verifying}
                  onClick={() => {
                    setVerifying(true);
                    void verifyMakerDeniability(id, reportId)
                      .then(setVerified)
                      .catch((e) => pushToast("error", e.message))
                      .finally(() => setVerifying(false));
                  }}
                >
                  Verify
                </Button>
              </div>
              {verified !== null && (
                <div
                  className={`mt-4 flex items-center gap-2 text-[12px] ${verified ? "text-success" : "text-danger"}`}
                >
                  <CheckCircle2 size={15} />
                  {verified ? "Proof is valid" : "Proof could not be validated"}
                </div>
              )}
              {report.deniabilityProof && (
                <div className="mt-4">
                  <Disclosure label="Technical proof data">
                    <pre
                      className="max-h-[320px] overflow-auto rounded-control border border-line
                        bg-surface p-4 text-[10px] text-muted"
                    >
                      {JSON.stringify(report.deniabilityProof, null, 2)}
                    </pre>
                  </Disclosure>
                </div>
              )}
            </Card>
          </main>
          <aside>
            <Card className="sticky top-4 border-line-strong p-5">
              <h2 className="font-header text-[14px] font-bold">Settlement</h2>
              <div className="mt-4 divide-y divide-line">
                {[
                  ["Fee earned", <SatsAmount sats={report.feeEarnedSats} />],
                  ["Incoming", <SatsAmount sats={report.incomingAmountSats} />],
                  ["Outgoing", <SatsAmount sats={report.outgoingAmountSats} />],
                  ["Timelock", `${report.timelock.toLocaleString()} blocks`],
                  ["Duration", formatDuration(report.swapDurationSeconds)],
                ].map(([label, value]) => (
                  <div
                    key={String(label)}
                    className="flex justify-between gap-4 py-3 text-[11.5px]"
                  >
                    <span className="text-muted">{label}</span>
                    <strong className="text-right font-mono">{value}</strong>
                  </div>
                ))}
              </div>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}
