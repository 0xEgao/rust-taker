import type { ReactNode } from "react";

import { formatTorEndpoint } from "../../../lib/market-format";
import { ACT_LABEL, EDGE_STAGE_LABEL, type CircuitView } from "./useSwapCircuit";

/**
 * Answers "how much longer", as a strip under the circuit. Honest dead time: a block-height
 * ticker and a countdown are activity; a spinner during a ten-minute confirmation wait is a lie.
 */
export function Vitals({
  view,
  elapsed,
  blockHeight,
}: {
  view: CircuitView;
  /** Owns its own tick, so the circuit doesn't re-render once a second. */
  elapsed: ReactNode;
  blockHeight: number | null;
}) {
  const total = view.routerCount + 1;
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-control border border-line bg-line sm:grid-cols-4">
      <VitalCell label="Elapsed" value={elapsed} />
      <VitalCell label="Confirmed" value={`${view.hopsConfirmed} of ${total} hops`} />
      <VitalCell label="Block" value={blockHeight === null ? "—" : blockHeight.toLocaleString()} />
      <VitalCell label="Stage" value={view.failed ? "Failed" : ACT_LABEL[view.act]} />
    </div>
  );
}

function VitalCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 bg-surface px-3 py-2.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-subtle">{label}</span>
      <span className="font-numeric text-[13px] text-foreground">{value}</span>
    </div>
  );
}

/**
 * The money question, under the circuit: which contract the live leg is, and what would happen
 * to the funds if the swap stopped here. What the swap is *doing* is the circuit's centre —
 * repeating it here would just be the same sentence twice on one screen.
 */
export function NowPanel({ view }: { view: CircuitView }) {
  const edge = view.liveEdgeIndex === null ? null : view.edges[view.liveEdgeIndex];

  const safety = view.failed
    ? "Your funds are recoverable through the contract's timelock or hashlock path."
    : view.focusIndex === null
      ? "Nothing is left in contract — the swap is settled and the coins are spendable."
      : view.committed
        ? "Your funds are locked in a contract you can reclaim after its refund window if this fails."
        : "Nothing is on-chain yet — this swap can still be cancelled with no loss.";

  return (
    <div
      className="rounded-control border bg-surface p-3"
      style={{ borderColor: view.failed ? "var(--color-danger)" : "var(--color-line)" }}
    >
      {edge && (
        <p className="font-mono text-[11px] text-foreground">
          {edge.index === 0
            ? `Your funding transaction${edge.contractCount > 1 ? "s" : ""}`
            : edge.index === view.routerCount
              ? `Router ${edge.index}'s contract${
                  edge.contractCount > 1 ? "s" : ""
                } — the one${edge.contractCount > 1 ? "s" : ""} that pay${
                  edge.contractCount > 1 ? "" : "s"
                } you`
              : `Router ${edge.index} → Router ${edge.index + 1}`}
          {edge.contractCount > 1 && ` · ${edge.contractCount} splits`}
          {" · "}
          {EDGE_STAGE_LABEL[edge.stage]}
          {edge.amountSats !== undefined && ` · ${edge.amountSats.toLocaleString()} sats`}
          {edge.txid && ` · ${formatTorEndpoint(edge.txid, 8, 4)}`}
        </p>
      )}
      <p className="mt-1.5 font-mono text-[10px] text-subtle">{safety}</p>
      {view.failed && view.failureReason && (
        <p className="mt-1.5 break-all font-mono text-[9px] text-danger">{view.failureReason}</p>
      )}
    </div>
  );
}
