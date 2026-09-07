import { useMemo } from "react";

import type {
  RouterFeeInfo,
  RouterStage,
  SwapSummary,
  SwapTrackerProgress,
  TrackerPhase,
} from "../../../api/types";

/** Six acts, one headline each. Acts before `route` have nothing on-chain — see `committed`. */
export type Act = "find" | "deal" | "fund" | "route" | "unlock" | "settle";

export const ACT_LABEL: Record<Act, string> = {
  find: "Find",
  deal: "Deal",
  fund: "Fund",
  route: "Route",
  unlock: "Unlock",
  settle: "Settle",
};

/**
 * The per-router protocol stages, as prose. `STAGE_DOING` narrates the live hop; `STAGE_LABEL`
 * is the word under a router on the ring.
 */
const STAGE_DOING: Record<RouterStage, string> = {
  waiting: "Waiting its turn on the route",
  negotiated: "Terms agreed, waiting its turn",
  handshaking: "Handshaking over Tor and exchanging contracts",
  confirming: "Waiting for its contract to confirm on-chain",
  routed: "Contract confirmed, waiting for its private key",
  key_received: "Its key is yours, forwarding it to the next hop",
  settled: "Key forwarded to the next hop",
};

export const STAGE_LABEL: Record<RouterStage, string> = {
  waiting: "Waiting",
  negotiated: "Negotiated",
  handshaking: "Handshaking",
  confirming: "Confirming",
  routed: "Routed",
  key_received: "Key received",
  settled: "Settled",
};

/**
 * Past-tense name for each flag the crate sets, keyed by its field name. Both protocols' flag
 * sets are here — a router carries one set or the other, never both. This is hover-card detail
 * only: the flags are not evenly spaced in time, and taproot writes five of them at once, so
 * the narrative comes from `stage` instead.
 */
const MILESTONE_LABEL: Record<string, string> = {
  negotiated: "Terms agreed",
  connected: "Connected",

  contract_data_sent: "Contract sent",
  maker_contract_received: "Contract received",
  swapcoins_created: "Swap coins built",

  sender_sigs_requested: "Signatures requested",
  sender_sigs_received: "Signatures received",
  prev_funding_broadcast: "Incoming funding broadcast",
  prev_funding_confirmed: "Incoming funding confirmed",
  proof_of_funding_sent: "Proof of funding sent",
  maker_contracts_received: "Contracts received",
  next_maker_sigs_obtained: "Next hop signed",
  prev_maker_sigs_obtained: "Previous hop signed",
  combined_sigs_sent: "Combined signatures sent",
  maker_funding_confirmed: "Contract confirmed on-chain",
  watchonly_created: "Contract watched",

  privkey_received: "Private key received",
  privkey_forwarded: "Private key forwarded",
};

/**
 * What the swap is doing at each phase, for the stretches with no router of its own to name:
 * everything before the funds move, and the final sweep after the last key is forwarded.
 * Each phase names the *next* piece of work, since the crate stamps a phase on completing one.
 */
const PHASE_DOING: Record<TrackerPhase, string> = {
  routers_discovered: "Negotiating terms with the routers",
  negotiated: "Building your funding transaction",
  funding_created: "Broadcasting your funding transaction",
  funds_broadcast: "Routing your funds into the first contract",
  contracts_exchanged: "Waiting for the routed contracts to confirm",
  finalizing: "Exchanging private keys around the route",
  privkeys_forwarded: "Sweeping the incoming contract into your wallet",
  completed: "Swept to your wallet",
  failed: "Stopped — recovery reclaims anything already on-chain",
};

/** An edge is a contract transaction, so it has its own lifecycle independent of its endpoints. */
export type EdgeStage = "pending" | "built" | "broadcast" | "confirming" | "confirmed";

export const EDGE_STAGE_LABEL: Record<EdgeStage, string> = {
  pending: "Not started",
  built: "Built",
  broadcast: "Broadcast",
  confirming: "Confirming",
  confirmed: "Confirmed",
};

export type Tone = "idle" | "active" | "success" | "danger";

export interface Milestone {
  key: string;
  label: string;
  done: boolean;
}

export interface HopView {
  index: number;
  address: string;
  label: string;
  stage: RouterStage;
  tone: Tone;
  fee?: RouterFeeInfo;
  milestones: Milestone[];
}

export interface EdgeView {
  index: number;
  stage: EdgeStage;
  tone: Tone;
  /** Amount still travelling after this hop's fee is deducted. */
  amountSats?: number;
  /** From `RouterFeeInfo.locktime` — the refund window on this contract, in blocks. */
  locktimeBlocks?: number;
  txid?: string;
  confirmedHeight?: number;
}

export interface CircuitView {
  routerCount: number;
  act: Act;
  /** True once funds are on-chain. Before this the swap can still be abandoned. */
  committed: boolean;
  failed: boolean;
  failureReason?: string;
  hops: HopView[];
  edges: EdgeView[];
  /** Index of the hop currently doing something, or null when nothing is live. */
  focusIndex: number | null;
  /** The contract the swap is blocked on: the first leg that isn't confirmed. */
  liveEdgeIndex: number | null;
  /** One sentence: what the swap is actually doing right now. */
  activity: string;
  hopsConfirmed: number;
  sendAmountSats?: number;
  receiveAmountSats?: number;
  totalFeeSats?: number;
}

const PHASE_ACT: Record<TrackerPhase, Act> = {
  routers_discovered: "find",
  negotiated: "deal",
  funding_created: "fund",
  funds_broadcast: "route",
  contracts_exchanged: "route",
  finalizing: "unlock",
  privkeys_forwarded: "unlock",
  completed: "settle",
  failed: "route",
};

const COMMITTED_PHASES: TrackerPhase[] = [
  "funds_broadcast",
  "contracts_exchanged",
  "finalizing",
  "privkeys_forwarded",
  "completed",
];

/** Stage order, for the "has this hop got at least this far" comparisons below. */
const STAGE_ORDER: RouterStage[] = [
  "waiting",
  "negotiated",
  "handshaking",
  "confirming",
  "routed",
  "key_received",
  "settled",
];

const atLeast = (stage: RouterStage, min: RouterStage) =>
  STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(min);

export function useSwapCircuit(
  tracker: SwapTrackerProgress | null,
  summary: SwapSummary | null,
  failure: boolean,
): CircuitView {
  return useMemo<CircuitView>(() => {
    const routerCount = summary?.routers.length ?? tracker?.routerCount ?? 2;
    const phase: TrackerPhase = tracker?.phase ?? "routers_discovered";
    const failed = failure || phase === "failed";
    const act = PHASE_ACT[phase];
    const committed = COMMITTED_PHASES.includes(phase);

    const hops: HopView[] = Array.from({ length: routerCount }, (_, index) => {
      const fee = summary?.routers[index];
      const address = fee?.address ?? tracker?.routers[index]?.address ?? `router-${index}`;
      const live = tracker?.routers.find((r) => r.address === address) ?? tracker?.routers[index];
      return {
        index,
        address,
        label: `Router ${index + 1}`,
        stage: live?.stage ?? "waiting",
        tone: "idle" as Tone,
        fee,
        milestones: (live?.milestones ?? []).map((m) => ({
          key: m.key,
          label: MILESTONE_LABEL[m.key] ?? m.key.replace(/_/g, " "),
          done: m.done,
        })),
      };
    });

    // Routing walks the route once to get every contract confirmed; the key exchange then walks
    // it again to settle each hop. So which hop is live depends on which pass the swap is on —
    // during the second one, hops sitting at `routed` are still waiting their turn.
    const focusIndex = (() => {
      if (phase === "completed") return null;
      const target: RouterStage = act === "unlock" || act === "settle" ? "settled" : "routed";
      const idx = hops.findIndex((h) => !atLeast(h.stage, target));
      return idx === -1 ? null : idx;
    })();

    hops.forEach((hop) => {
      hop.tone =
        failed && hop.index === focusIndex
          ? "danger"
          : hop.index === focusIndex
            ? "active"
            : atLeast(hop.stage, "routed")
              ? "success"
              : "idle";
    });

    // Edge k carries the value leaving slot k. Amounts descend as each router takes its fee.
    let running = summary?.sendAmountSats ?? tracker?.sendAmountSats;
    const edges: EdgeView[] = Array.from({ length: routerCount + 1 }, (_, index) => {
      const amountSats = running;
      const fee = summary?.routers[index];
      if (running !== undefined && fee) running = running - fee.estimatedFeeSats;

      let stage: EdgeStage = "pending";
      if (index === 0) {
        // Your own funding transaction. Legacy reports its confirmation directly; taproot never
        // does, but a maker won't fund its own contract until ours has confirmed, so its hop
        // reaching `routed` says so after the fact.
        const ours = hops[0]?.milestones.find((m) => m.key === "prev_funding_confirmed");
        if (ours?.done || (hops[0] && atLeast(hops[0].stage, "routed"))) stage = "confirmed";
        else if (committed) stage = "broadcast";
        else if (phase === "funding_created") stage = "built";
      } else {
        // Edge k is the contract router k funds, so it tracks that router's own stage.
        const source = hops[index - 1];
        if (source && atLeast(source.stage, "routed")) stage = "confirmed";
        else if (source?.stage === "confirming") stage = "confirming";
        else if (source?.stage === "handshaking") stage = "broadcast";
      }
      if (phase === "completed") stage = "confirmed";

      const tone: Tone =
        stage === "confirmed" ? "success" : stage === "pending" ? "idle" : "active";

      return {
        index,
        stage,
        tone,
        amountSats,
        locktimeBlocks: summary?.routers[Math.min(index, routerCount - 1)]?.locktime,
      };
    });

    // Router k funds edge k+1, so a hop index is never an edge index. Asking which leg is
    // unconfirmed answers "what is the swap waiting on" without that off-by-one.
    const liveEdge = edges.findIndex((e) => e.stage !== "confirmed");
    if (failed && liveEdge !== -1) edges[liveEdge].tone = "danger";

    // A router that hasn't been reached yet isn't the story — the phase is. Once the swap is
    // working on one, that router's stage is the specific thing to say.
    const focusHop = focusIndex === null ? null : hops[focusIndex];
    const activity =
      failed || focusHop === null || focusHop.stage === "waiting"
        ? PHASE_DOING[failed ? "failed" : phase]
        : `${focusHop.label} · ${STAGE_DOING[focusHop.stage]}`;

    return {
      routerCount,
      act,
      committed,
      failed,
      failureReason: tracker?.failureReason,
      hops,
      edges,
      focusIndex,
      liveEdgeIndex: liveEdge === -1 ? null : liveEdge,
      activity,
      hopsConfirmed: edges.filter((e) => e.stage === "confirmed").length,
      sendAmountSats: summary?.sendAmountSats ?? tracker?.sendAmountSats,
      receiveAmountSats: summary?.estimatedReceiveAmountSats,
      totalFeeSats: summary?.totalEstimatedFeeSats,
    };
  }, [tracker, summary, failure]);
}
