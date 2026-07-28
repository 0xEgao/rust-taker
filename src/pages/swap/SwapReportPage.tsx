import { ArrowLeft, CheckCircle2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getOffers, getSwapReport, verifyDeniability } from "../../api/commands";
import type { MakerFeeInfo, Offer, SwapReportDetail, SwapStatus } from "../../api/types";
import { isAppError } from "../../api/types";
import { Card, Disclosure, ExternalLinkButton, Modal, SatsAmount } from "../../components/ui/display";
import { Button } from "../../components/ui/inputs";
import { withMinDelay } from "../../lib/timing";
import { formatDuration, SWAP_STATUS_ICON, SWAP_STATUS_TEXT_TONE, truncateMiddle } from "../../lib/wallet-format";

const STATUS_LABEL: Record<SwapStatus, string> = {
  success: "Completed",
  recovery_hashlock: "Recovered (hashlock)",
  recovery_timelock: "Recovered (timelock)",
  failed: "Failed",
};

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 border-line-strong p-5">
      <h3 className="font-header text-[14px] font-bold text-foreground">{title}</h3>
      {children}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span className="text-subtle">{label}</span>
      <span className="text-right font-mono text-foreground">{children}</span>
    </div>
  );
}

function TxidRow({ label, txid }: { label: string; txid: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3 py-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[10.5px] uppercase tracking-wide text-subtle">{label}</span>
        <span className="truncate font-mono text-[11.5px] text-muted">{truncateMiddle(txid, 12, 8)}</span>
      </span>
      <ExternalLinkButton txid={txid} />
    </div>
  );
}

// Renders whatever the crate's DeniabilityProof JSON happens to contain, without hardcoding
// field names — the Taproot/Legacy variants differ and the proof shape may evolve upstream.
function JsonEntries({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className="text-subtle">—</span>;

  if (typeof value === "string") {
    return <span className="break-all font-mono text-[11px] text-muted">{value.length > 24 ? truncateMiddle(value, 12, 8) : value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="font-mono text-[11px] text-muted">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    return (
      <div className="flex flex-col gap-1.5" style={{ marginLeft: depth > 0 ? 12 : 0 }}>
        {value.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="font-mono text-[10px] text-subtle">[{i}]</span>
            <JsonEntries value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <div className="flex flex-col gap-1.5" style={{ marginLeft: depth > 0 ? 12 : 0 }}>
      {entries.map(([key, val]) => (
        <div key={key} className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">{key}</span>
          <JsonEntries value={val} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

export function SwapReportPage() {
  const { swapId } = useParams<{ swapId: string }>();
  const navigate = useNavigate();
  const [report, setReport] = useState<SwapReportDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [selectedMaker, setSelectedMaker] = useState<{ index: number; address: string; fee?: MakerFeeInfo } | null>(null);
  const [offerByAddress, setOfferByAddress] = useState<Record<string, Offer>>({});

  useEffect(() => {
    if (!swapId) return;
    void getSwapReport(swapId).then(setReport).catch(() => setNotFound(true));
  }, [swapId]);

  // Fidelity bond data isn't part of the swap report — it lives on the maker's current offer.
  // Fetched lazily on first modal open (not mount) since nothing else on this page needs it, and
  // best-effort: the maker may no longer be posting offers, in which case the modal says so.
  const offersFetched = useRef(false);
  function openMakerModal(maker: { index: number; address: string; fee?: MakerFeeInfo }) {
    setSelectedMaker(maker);
    if (offersFetched.current) return;
    offersFetched.current = true;
    void getOffers()
      .then((book) => {
        const map: Record<string, Offer> = {};
        for (const m of [...book.good, ...book.bad, ...book.unresponsive]) {
          if (m.offer) map[m.address] = m.offer;
        }
        setOfferByAddress(map);
      })
      .catch(() => {});
  }

  const provenOutpoint = report?.provenOutpoint ?? null;

  async function handleVerify() {
    if (!swapId) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      // The actual RPC check resolves near-instantly, which reads as "did anything happen?" —
      // hold the loading state for a beat so the check is perceptible.
      const ok = await withMinDelay(verifyDeniability(swapId), 900);
      setVerifyResult({
        ok,
        message: ok
          ? "The proof's signatures and contract details check out against the blockchain."
          : "The proof did not verify against the blockchain — it may be incomplete or the contract may not have been observed on-chain.",
      });
    } catch (e) {
      setVerifyResult({ ok: false, message: isAppError(e) ? e.message : "Failed to verify deniability proof." });
    } finally {
      setVerifying(false);
    }
  }

  if (notFound) {
    return (
      <div className="grid h-full place-items-center gap-3 text-center">
        <p className="text-[13px] text-subtle">No report found for this swap.</p>
        <Button variant="secondary" onClick={() => navigate("/swap/reports")}>
          Back to Swap Reports
        </Button>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="grid h-full place-items-center gap-2.5 text-center text-[13px] text-subtle">
        <RefreshCw size={28} strokeWidth={1.6} className="animate-spin text-primary" />
        <span>Loading swap report…</span>
      </div>
    );
  }

  const Icon = SWAP_STATUS_ICON[report.status];
  const isFailure = report.status === "failed";

  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 pb-8 pt-2">
      <div className="flex shrink-0 items-center gap-3 pb-4">
        <button
          type="button"
          onClick={() => navigate("/swap/reports")}
          title="Back to Swap Reports"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-control border border-line text-muted transition-colors hover:border-line-strong hover:text-foreground"
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>
        <div className="flex items-center gap-2.5">
          <Icon size={22} strokeWidth={2} className={SWAP_STATUS_TEXT_TONE[report.status]} />
          <div>
            <h1 className="font-header text-[20px] font-bold text-foreground">{truncateMiddle(report.swapId, 18, 10)}</h1>
            <p className={`mt-0.5 text-[11.5px] font-medium ${SWAP_STATUS_TEXT_TONE[report.status]}`}>{STATUS_LABEL[report.status]}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_1fr]">
        <div className="flex flex-col gap-4">
          <SectionCard title="Summary">
            <div className="grid grid-cols-3 gap-3 rounded-control border border-line-strong bg-surface-raised px-3.5 py-3 text-center">
              <div>
                <div className="font-mono text-[9px] uppercase tracking-widest text-subtle">Sent</div>
                <SatsAmount sats={report.outgoingAmountSats} className="mt-1 text-[13px] font-semibold text-foreground" />
              </div>
              <div>
                <div className="font-mono text-[9px] uppercase tracking-widest text-subtle">Received</div>
                <SatsAmount sats={report.receivedAmountSats} className="mt-1 text-[13px] font-semibold text-foreground" />
              </div>
              <div>
                <div className="font-mono text-[9px] uppercase tracking-widest text-subtle">Duration</div>
                <div className="mt-1 font-mono text-[13px] font-semibold text-foreground">{formatDuration(report.swapDurationSeconds)}</div>
              </div>
            </div>
            <Row label="Network">{report.network}</Row>
            <Row label="Total fee paid">
              <SatsAmount sats={report.feePaidSats} />
            </Row>
            <Row label="Fee percentage">{report.feePercentage.toFixed(4)}%</Row>
            <Row label="Mining fee">
              <SatsAmount sats={report.miningFeeSats} />
            </Row>
            <Row label="Maker fees">
              <SatsAmount sats={report.totalMakerFeesSats} />
            </Row>
            {isFailure && report.errorMessage && (
              <div className="mt-1 flex items-start gap-2 rounded-control border border-danger/35 bg-danger/[0.06] px-3.5 py-2.5 text-[12px] text-danger">
                <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 flex-none" />
                <span>{report.errorMessage}</span>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Transactions">
            {report.outgoingContractTxid && <TxidRow label="Outgoing Contract" txid={report.outgoingContractTxid} />}
            {report.incomingContractTxid && <TxidRow label="Incoming Contract" txid={report.incomingContractTxid} />}
            {report.fundingTxids.map((hopTxids, hopIdx) =>
              hopTxids.map((txid, i) => <TxidRow key={`${hopIdx}-${i}`} label={`Funding · Hop ${hopIdx + 1}`} txid={txid} />),
            )}
            {!report.outgoingContractTxid && !report.incomingContractTxid && report.fundingTxids.flat().length === 0 && (
              <p className="text-[12px] text-subtle">No transaction data recorded for this swap.</p>
            )}
          </SectionCard>

          <SectionCard title="Wallet Outputs">
            {report.inputUtxoAmountsSats.length > 0 && (
              <div>
                <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Input UTXOs</span>
                <div className="mt-1 flex flex-wrap gap-2">
                  {report.inputUtxoAmountsSats.map((amt, i) => (
                    <SatsAmount key={i} sats={amt} className="rounded-control border border-line bg-surface-raised px-2 py-1 text-[11px] text-foreground" />
                  ))}
                </div>
              </div>
            )}
            {report.outputChangeUtxos.length > 0 && (
              <div>
                <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Change UTXOs</span>
                <div className="mt-1 flex flex-col gap-1.5">
                  {report.outputChangeUtxos.map(([amt, addr], i) => (
                    <div key={i} className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3 py-1.5">
                      <span className="truncate font-mono text-[11px] text-muted">{addr}</span>
                      <SatsAmount sats={amt} className="flex-none text-[11px] text-foreground" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {report.outputSwapUtxos.length > 0 && (
              <div>
                <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Swap UTXOs</span>
                <div className="mt-1 flex flex-col gap-1.5">
                  {report.outputSwapUtxos.map(([amt, addr], i) => (
                    <div key={i} className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3 py-1.5">
                      <span className="truncate font-mono text-[11px] text-muted">{addr}</span>
                      <SatsAmount sats={amt} className="flex-none text-[11px] text-success" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {report.inputUtxoAmountsSats.length === 0 && report.outputChangeUtxos.length === 0 && report.outputSwapUtxos.length === 0 && (
              <p className="text-[12px] text-subtle">No wallet output data recorded for this swap.</p>
            )}
          </SectionCard>
        </div>

        <div className="flex flex-col gap-4">
          <SectionCard title={`Swap Partners (${report.makersCount})`}>
            {report.makerAddresses.length === 0 && <p className="text-[12px] text-subtle">No makers recorded.</p>}
            {report.makerAddresses.map((address, i) => {
              const fee = report.makerFeeInfo.find((m) => m.makerIndex === i) ?? report.makerFeeInfo[i];
              return (
                <button
                  key={address}
                  type="button"
                  onClick={() => openMakerModal({ index: i, address, fee })}
                  className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3.5 py-3 text-left transition-colors hover:border-line-strong hover:bg-white/[0.04]"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-foreground">Maker {i + 1}</span>
                    <span className="truncate font-mono text-[10.5px] text-subtle">{truncateMiddle(address, 14, 8)}</span>
                  </span>
                  {fee && <SatsAmount sats={fee.totalFeeSats} className="flex-none text-[12px] font-semibold text-warning" />}
                </button>
              );
            })}
          </SectionCard>

          <SectionCard title="Deniability Proof">
            {report.deniabilityProof ? (
              <>
                {provenOutpoint && (
                  <div className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3.5 py-2">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wide text-subtle">Proven outpoint</span>
                      <span className="truncate font-mono text-[11px] text-muted">
                        {truncateMiddle(provenOutpoint.txid, 10, 6)}:{provenOutpoint.vout}
                      </span>
                    </span>
                    <ExternalLinkButton txid={provenOutpoint.txid} />
                  </div>
                )}
                <div className="flex items-center gap-2.5">
                  <Button size="sm" variant="secondary" onClick={() => void handleVerify()} loading={verifying}>
                    Verify on-chain
                  </Button>
                  {verifying && <span className="text-[11.5px] text-subtle">Checking outpoint on-chain…</span>}
                </div>
                {verifyResult && !verifying && (
                  <div
                    className={`flex items-start gap-2 rounded-control border px-3.5 py-2.5 text-[12px] ${
                      verifyResult.ok ? "border-success/35 bg-success/[0.06] text-success" : "border-danger/35 bg-danger/[0.06] text-danger"
                    }`}
                  >
                    {verifyResult.ok ? (
                      <CheckCircle2 size={14} strokeWidth={2} className="mt-0.5 flex-none" />
                    ) : (
                      <XCircle size={14} strokeWidth={2} className="mt-0.5 flex-none" />
                    )}
                    <span>
                      <strong className="font-semibold">{verifyResult.ok ? "Verified on-chain." : "Verification failed."}</strong>{" "}
                      {verifyResult.message}
                    </span>
                  </div>
                )}
                <Disclosure label="Show proof details">
                  <div className="rounded-control border border-line bg-surface-raised px-3.5 py-3">
                    <JsonEntries value={report.deniabilityProof} />
                  </div>
                </Disclosure>
              </>
            ) : (
              <p className="text-[12px] text-subtle">No deniability proof was generated for this swap.</p>
            )}
          </SectionCard>
        </div>
      </div>

      {selectedMaker && (
        <Modal title={`Maker ${selectedMaker.index + 1}`} onClose={() => setSelectedMaker(null)}>
          <Row label="Address">
            <span className="break-all text-left">{selectedMaker.address}</span>
          </Row>
          <Row label="Route position">{selectedMaker.index + 1}</Row>
          {selectedMaker.fee ? (
            <>
              <Row label="Base fee">
                <SatsAmount sats={selectedMaker.fee.baseFeeSats} />
              </Row>
              <Row label="Amount-relative fee">
                <SatsAmount sats={selectedMaker.fee.amountRelativeFeeSats} />
              </Row>
              <Row label="Time-relative fee">
                <SatsAmount sats={selectedMaker.fee.timeRelativeFeeSats} />
              </Row>
              <Row label="Total fee">
                <SatsAmount sats={selectedMaker.fee.totalFeeSats} className="font-bold text-warning" />
              </Row>
            </>
          ) : (
            <p className="text-[12px] text-subtle">No fee breakdown recorded for this maker.</p>
          )}

          <div className="mt-1 border-t border-dashed border-line pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Fidelity Bond</span>
            {(() => {
              const bond = offerByAddress[selectedMaker.address];
              return bond ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  <Row label="Bond amount">
                    <SatsAmount sats={bond.bondAmountSats} />
                  </Row>
                  <Row label="Locktime height">{bond.bondLocktimeHeight}</Row>
                  <Row label="Status">{bond.bondIsSpent ? "Spent" : "Unspent"}</Row>
                  <TxidRow label="Bond Transaction" txid={bond.bondTxid} />
                </div>
              ) : (
                <p className="mt-2 text-[12px] text-subtle">
                  This maker isn't in the current offerbook, so its fidelity bond can't be looked up.
                </p>
              );
            })()}
          </div>

          <div className="mt-1 border-t border-dashed border-line pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Transactions</span>
            <div className="mt-2 flex flex-col gap-1.5">
              {(report.fundingTxids[selectedMaker.index] ?? []).map((txid, i) => (
                <TxidRow key={i} label={`Funding ${i + 1}`} txid={txid} />
              ))}
              {(report.fundingTxids[selectedMaker.index] ?? []).length === 0 && (
                <p className="text-[12px] text-subtle">No transactions recorded for this maker.</p>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
