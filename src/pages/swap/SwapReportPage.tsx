import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Timer, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getIncomingSwapUtxo, getOffers, getSwapReport, verifyDeniability } from "../../api/commands";
import type { ReportRouterFee, ReportUtxo, Offer, SwapReportDetail, SwapStatus, SwapUtxo } from "../../api/types";
import { isAppError } from "../../api/types";
import { BackButton, Card, CopyButton, Disclosure, ExternalLinkButton, IndeterminateBar, Modal, SatsAmount } from "../../components/ui/display";
import { Button, LinkButton } from "../../components/ui/inputs";
import { formatDuration, SATS_PER_BTC, swapStatusPresentation, truncateMiddle } from "../../lib/wallet-format";

const STATUS_LABEL: Record<SwapStatus, string> = {
  success: "Completed",
  recovery_hashlock: "Recovered (hashlock)",
  recovery_timelock: "Recovered (timelock)",
  recovered: "Interrupted · recovered",
  interrupted: "Interrupted · recovering",
  unfinished: "Never finished",
  failed: "Failed",
};

// One accent per hop so a funding tx is visually tied to the router it funded, matching the
// per-router colours the old app used in this same list.
const HOP_ACCENTS = ["var(--color-primary)", "var(--color-info)", "var(--color-router)", "var(--color-success)"];
const OUTGOING_ACCENT = "var(--color-warning)";

function satsToBtc(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(8);
}

function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** Full txid, not truncated — the whole point of this row is being able to read and copy it. */
function TxArtifact({ label, caption, txid, vout, amountSats, accent, arrow }: {
  label: string;
  caption?: string;
  txid: string;
  vout?: number;
  amountSats?: number;
  accent: string;
  arrow: string;
}) {
  // `txid:vout` names the coin, which is what the contract actually holds; a bare txid only
  // names the transaction that created it.
  const reference = vout === undefined ? txid : `${txid}:${vout}`;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_34px_34px] items-center gap-2.5 rounded-control border border-line bg-surface-raised p-5">
      <div className="min-w-0">
        <h4 className="mb-3.5 flex items-center gap-3 text-[15px] font-extrabold text-foreground">
          <span className="font-mono" style={{ color: accent }} aria-hidden>
            {arrow}
          </span>
          {label}
        </h4>
        <p className="break-all font-mono text-[12px] leading-relaxed text-muted">{reference}</p>
        {amountSats !== undefined && (
          <p className="mt-2 font-numeric text-[13px] text-foreground">
            <SatsAmount sats={amountSats} />
          </p>
        )}
        {caption && <p className="mt-2 text-[11.5px] leading-5 text-subtle">{caption}</p>}
      </div>
      <CopyButton text={reference} title={vout === undefined ? "Copy transaction ID" : "Copy outpoint"} />
      <ExternalLinkButton txid={txid} />
    </div>
  );
}

// The report names these coins by address and value only, with no outpoint to link out to.
/**
 * The crate writes the literal string "Unknown" when it cannot resolve an address, and its
 * Electrum backend never can — that backend builds every UTXO entry with `address: None`
 * (`wallet/blockchain/electrum.rs`). Printing that word where an address belongs tells the
 * reader nothing, so it is treated as absent everywhere it could reach the page.
 */
function identifiedAddress(utxo: { address: string }): string | null {
  const address = utxo.address?.trim();
  return address && address !== "Unknown" ? address : null;
}

function CoinRow({ label, caption, coins, accent, arrow }: {
  label: string;
  caption: string;
  coins: ReportUtxo[];
  accent: string;
  arrow: string;
}) {
  return (
    <div className="rounded-control border border-line bg-surface-raised p-5">
      <h4 className="mb-3.5 flex items-center gap-3 text-[15px] font-extrabold text-foreground">
        <span className="font-mono" style={{ color: accent }} aria-hidden>
          {arrow}
        </span>
        {label}
      </h4>
      <div className="flex flex-col gap-3">
        {coins.map((coin, i) => {
          const address = identifiedAddress(coin);
          return (
            <div
              key={`${coin.address}-${i}`}
              className="grid grid-cols-[minmax(0,1fr)_34px] items-center gap-2.5"
            >
              <div className="min-w-0">
                {address && (
                  <p className="break-all font-mono text-[12px] leading-relaxed text-muted">
                    {address}
                  </p>
                )}
                <p
                  className={`font-numeric text-[13px] text-foreground${address ? " mt-2" : ""}`}
                >
                  <SatsAmount sats={coin.valueSats} />
                </p>
              </div>
              {address && <CopyButton text={address} title="Copy address" />}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11.5px] leading-5 text-subtle">{caption}</p>
    </div>
  );
}

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
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">{label}</span>
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
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">{key}</span>
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
  const [selectedRouter, setSelectedRouter] = useState<{ index: number; address: string; fee?: ReportRouterFee } | null>(null);
  const [offerByAddress, setOfferByAddress] = useState<Record<string, Offer>>({});
  const [incomingUtxo, setIncomingUtxo] = useState<SwapUtxo | null>(null);
  const [utxoState, setUtxoState] = useState<"idle" | "loading" | "done" | "failed">("idle");

  useEffect(() => {
    if (!swapId) return;
    void getSwapReport(swapId).then(setReport).catch(() => setNotFound(true));
  }, [swapId]);

  // Reports written before upstream PR #1006 don't record the sweep outputs, so for those the
  // received coin has to be read off the chain, at a round-trip per candidate transaction.
  const loadIncomingUtxo = useCallback(() => {
    if (!swapId || utxoState === "loading") return;
    setUtxoState("loading");
    void getIncomingSwapUtxo(swapId)
      .then((utxo) => {
        setIncomingUtxo(utxo);
        setUtxoState("done");
      })
      .catch(() => setUtxoState("failed"));
  }, [swapId, utxoState]);

  // Only entries we can actually name. An unnamed one must not satisfy this, or the chain
  // lookup below never runs and the page settles for showing nothing useful.
  const reportedIncoming = (report?.incomingUtxos ?? []).filter(identifiedAddress);
  useEffect(() => {
    if (swapId && report && reportedIncoming.length === 0 && utxoState === "idle") {
      loadIncomingUtxo();
    }
  }, [swapId, report, reportedIncoming.length, utxoState, loadIncomingUtxo]);

  // Fidelity bond data isn't part of the swap report — it lives on the router's current offer.
  // Fetched lazily on first modal open (not mount) since nothing else on this page needs it, and
  // best-effort: the router may no longer be posting offers, in which case the modal says so.
  const offersFetched = useRef(false);
  function openRouterModal(router: { index: number; address: string; fee?: ReportRouterFee }) {
    setSelectedRouter(router);
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

  const outgoingContract = report?.outgoingContractOutpoint ?? null;

  async function handleVerify() {
    if (!swapId) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const ok = await verifyDeniability(swapId);
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

  // Resolved together and with a fallback: an unknown status must degrade, not blank the page.
  const { Icon, tone: statusTone, label: rawStatusLabel } = swapStatusPresentation(report.status);
  const isFailure = report.status === "failed";
  // Everything that is not a completed swap, matching how the reports list counts them. A
  // swap can stop in several ways and all of them can leave funds committed on-chain.
  const didNotComplete = report.status !== "success";

  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 pb-8 pt-2">
      <div className="flex shrink-0 items-center gap-3 pb-4">
        <BackButton to="/swap/reports" label="Back to Swap Reports" />
        <div className="flex items-center gap-2.5">
          <Icon size={22} strokeWidth={2} className={statusTone} />
          <div>
            <h1 className="font-header text-[20px] font-bold text-foreground">{truncateMiddle(report.swapId, 18, 10)}</h1>
            <p className={`mt-0.5 text-[11.5px] font-medium ${statusTone}`}>{STATUS_LABEL[report.status] ?? rawStatusLabel}</p>
          </div>
        </div>
      </div>

      {didNotComplete && (
        <div className="mb-4 flex shrink-0 flex-wrap items-start justify-between gap-3 rounded-control border border-danger/35 bg-danger/[0.06] px-4 py-3.5">
          <div className="flex min-w-0 items-start gap-3">
            <AlertTriangle size={18} strokeWidth={2} className="mt-0.5 flex-none text-danger" />
            <span className="flex min-w-0 flex-col gap-1">
              <strong className="text-[13px] font-semibold text-foreground">
                {report.errorMessage ? "Failure reason" : "This swap did not complete"}
              </strong>
              {report.errorMessage ? (
                <span className="break-words font-mono text-[11.5px] leading-relaxed text-danger">
                  {report.errorMessage}
                </span>
              ) : (
                <span className="text-[11.5px] leading-relaxed text-muted">
                  No reason was recorded for this one.
                </span>
              )}
            </span>
          </div>
          {/* What the reader actually wants next. Funds committed to a contract come back
              through recovery, and this page cannot tell them whether that finished — so it
              hands them straight there instead of leaving them to find it in the nav. */}
          <LinkButton
            to={`/swap/recovery/${encodeURIComponent(report.swapId)}`}
            size="sm"
            variant="secondary"
            className="flex-none"
          >
            <ShieldCheck size={14} strokeWidth={1.8} />
            Track recovery
          </LinkButton>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_1fr]">
        <div className="flex flex-col gap-4">
          <Card className="grid justify-items-center border-line-strong px-5 py-14 text-center">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">
              {isFailure ? "Attempted Amount" : "Amount Swapped"}
            </span>
            <SatsAmount sats={report.outgoingAmountSats} glyphScale={0.5} className="my-4 text-[clamp(38px,6vw,58px)] leading-none text-foreground" />
            <p className="mb-6 font-mono text-[14px] text-muted">≈ {satsToBtc(report.outgoingAmountSats)} BTC</p>
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/45 bg-primary/[0.12] px-4.5 py-2.5 font-mono text-[12px] uppercase tracking-[0.08em] text-primary-hover">
                <Timer size={15} strokeWidth={1.8} />
                Duration {formatDuration(report.swapDurationSeconds)}
              </span>
              <span className="inline-flex items-center rounded-full border border-line-strong bg-surface-raised px-4.5 py-2.5 font-mono text-[12px] uppercase tracking-[0.08em] text-muted">
                {report.network}
              </span>
            </div>
            <p className="mt-5 font-mono text-[11px] text-subtle">
              {formatTimestamp(report.startTimestamp)} → {formatTimestamp(report.endTimestamp)}
            </p>
          </Card>

          <SectionCard title="UTXOs">
            {outgoingContract && (
              <TxArtifact
                label="Outgoing UTXO"
                caption="The coin this wallet paid into the route"
                txid={outgoingContract.txid}
                vout={outgoingContract.vout}
                accent={OUTGOING_ACCENT}
                arrow="↗"
              />
            )}
            {report.outgoingUtxos.length > 0 && (
              <CoinRow
                label="Funding coins"
                caption="The wallet coins spent to fund the outgoing contract"
                coins={report.outgoingUtxos}
                accent={OUTGOING_ACCENT}
                arrow="↗"
              />
            )}
            {reportedIncoming.length > 0 ? (
              <CoinRow
                label="Incoming UTXO"
                caption="The coins the route paid back into this wallet"
                coins={reportedIncoming}
                accent={HOP_ACCENTS[0]}
                arrow="↙"
              />
            ) : incomingUtxo ? (
              <TxArtifact
                label="Incoming UTXO"
                caption={
                  incomingUtxo.address
                    ? `The coin the route paid back, at ${incomingUtxo.address}`
                    : "The coin the route paid back"
                }
                txid={incomingUtxo.txid}
                vout={incomingUtxo.vout}
                amountSats={incomingUtxo.amountSats}
                accent={HOP_ACCENTS[0]}
                arrow="↙"
              />
            ) : (
              // Not in the report file: the sweep that lands this coin happens after the report
              // is written, so it has to be read off the chain.
              <div className="flex flex-col gap-2 rounded-control border border-dashed border-line bg-surface-raised p-5">
                <h4 className="text-[15px] font-extrabold text-foreground">Incoming UTXO</h4>
                {/* The amount is recorded even when the outpoint is not, and it is the part
                    worth reading — so the card always carries it rather than being nothing
                    but an apology for what could not be resolved. */}
                {report.receivedAmountSats > 0 && (
                  <p className="font-numeric text-[13px] text-foreground">
                    <SatsAmount sats={report.receivedAmountSats} />
                    <span className="ml-1.5 text-[11.5px] text-subtle">received</span>
                  </p>
                )}
                {utxoState === "failed" ? (
                  <p className="text-[11.5px] text-danger">
                    Could not reach the chain backend to find it.
                  </p>
                ) : utxoState === "done" ? (
                  <p className="text-[11.5px] text-subtle">
                    The exact coin can't be pinned down yet — the sweep that lands it may not
                    have confirmed.
                  </p>
                ) : (
                  <p className="text-[11.5px] text-subtle">Reading the chain…</p>
                )}
                {utxoState !== "loading" && (
                  <Button size="sm" variant="secondary" onClick={loadIncomingUtxo}>
                    <RefreshCw size={14} strokeWidth={1.8} />
                    Try again
                  </Button>
                )}
              </div>
            )}
            {!outgoingContract &&
              !incomingUtxo &&
              report.outgoingUtxos.length === 0 &&
              reportedIncoming.length === 0 &&
              utxoState === "done" && (
                <p className="text-[12px] text-subtle">No UTXO data recorded for this swap.</p>
              )}
          </SectionCard>

          {report.fundingTxids.flat().length > 0 && (
            <SectionCard title="Funding Transactions">
              {report.fundingTxids.map((hopTxids, hopIdx) =>
                hopTxids.map((txid, i) => (
                  <TxArtifact
                    key={`${hopIdx}-${i}`}
                    label={`Hop ${hopIdx + 1}`}
                    txid={txid}
                    accent={HOP_ACCENTS[hopIdx % HOP_ACCENTS.length]}
                    arrow="→"
                  />
                )),
              )}
            </SectionCard>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <SectionCard title="Fee Details">
            <Row label="Received">
              <SatsAmount sats={report.receivedAmountSats} />
            </Row>
            <Row label="Router fees">
              <SatsAmount sats={report.totalRouterFeesSats} />
            </Row>
            <Row label="Mining fees">
              <SatsAmount sats={report.miningFeeSats} />
            </Row>
            <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-dashed border-line pt-3.5">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Total fee</span>
              <div className="text-right">
                <SatsAmount sats={report.feePaidSats} className="font-mono text-[26px] leading-none text-foreground" />
                <p className="mt-2 font-mono text-[12px] text-muted">{satsToBtc(report.feePaidSats)} BTC</p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-dashed border-line pt-3.5">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle"> % Of swap amount</span>
              <strong className="font-mono text-[15px] font-bold text-foreground">{report.feePercentage.toFixed(3)}%</strong>
            </div>
          </SectionCard>

          <SectionCard title={`Swap Partners (${report.routersCount})`}>
            {report.routerAddresses.length === 0 && <p className="text-[12px] text-subtle">No routers recorded.</p>}
            {report.routerAddresses.map((address, i) => {
              const fee = report.routerFeeInfo.find((m) => m.routerIndex === i) ?? report.routerFeeInfo[i];
              return (
                <button
                  key={address}
                  type="button"
                  onClick={() => openRouterModal({ index: i, address, fee })}
                  className="lift flex items-center justify-between gap-3 rounded-card border border-line bg-surface-raised px-3.5 py-3 text-left outline-none hover:border-line-strong hover:bg-[var(--color-hover)] focus-visible:shadow-ring"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-foreground">Router {i + 1}</span>
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
                {report.incomingContractOutpoint && (
                  <div className="flex items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3.5 py-2">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Proven outpoint</span>
                      <span className="truncate font-mono text-[11px] text-muted">
                        {truncateMiddle(report.incomingContractOutpoint.txid, 10, 6)}:
                        {report.incomingContractOutpoint.vout}
                      </span>
                    </span>
                    <ExternalLinkButton txid={report.incomingContractOutpoint.txid} />
                  </div>
                )}
                <div className="flex items-center gap-2.5">
                  <Button size="sm" variant="secondary" onClick={() => void handleVerify()} loading={verifying}>
                    Verify on-chain
                  </Button>
                </div>
                {verifying && (
                  <div className="flex flex-col gap-2">
                    <IndeterminateBar />
                    <span className="text-[11.5px] text-subtle">Fetching the contract transaction from the chain…</span>
                  </div>
                )}
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

      {selectedRouter && (
        <Modal title={`Router ${selectedRouter.index + 1}`} onClose={() => setSelectedRouter(null)}>
          <Row label="Address">
            <span className="break-all text-left">{selectedRouter.address}</span>
          </Row>
          <Row label="Route position">{selectedRouter.index + 1}</Row>
          {selectedRouter.fee ? (
            <>
              <Row label="Base fee">
                <SatsAmount sats={selectedRouter.fee.baseFeeSats} />
              </Row>
              <Row label="Amount-relative fee">
                <SatsAmount sats={selectedRouter.fee.amountRelativeFeeSats} />
              </Row>
              <Row label="Time-relative fee">
                <SatsAmount sats={selectedRouter.fee.timeRelativeFeeSats} />
              </Row>
              <Row label="Total fee">
                <SatsAmount sats={selectedRouter.fee.totalFeeSats} className="font-bold text-warning" />
              </Row>
            </>
          ) : (
            <p className="text-[12px] text-subtle">No fee breakdown recorded for this router.</p>
          )}

          <div className="mt-1 border-t border-dashed border-line pt-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Fidelity Bond</span>
            {(() => {
              const bond = offerByAddress[selectedRouter.address];
              return bond ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  <Row label="Bond amount">
                    <SatsAmount sats={bond.bondAmountSats} />
                  </Row>
                  <Row label="Locktime height">Block {bond.bondLocktimeHeight.toLocaleString()}</Row>
                  <Row label="Status">{bond.bondIsSpent ? "Spent" : "Unspent"}</Row>
                  <TxidRow label="Bond Transaction" txid={bond.bondTxid} />
                </div>
              ) : (
                <p className="mt-2 text-[12px] text-subtle">
                  This router isn't in the current offerbook, so its fidelity bond can't be looked up.
                </p>
              );
            })()}
          </div>

          <div className="mt-1 border-t border-dashed border-line pt-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Transactions</span>
            <div className="mt-2 flex flex-col gap-1.5">
              {(report.fundingTxids[selectedRouter.index] ?? []).map((txid, i) => (
                <TxidRow key={i} label={`Funding ${i + 1}`} txid={txid} />
              ))}
              {(report.fundingTxids[selectedRouter.index] ?? []).length === 0 && (
                <p className="text-[12px] text-subtle">No transactions recorded for this router.</p>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
