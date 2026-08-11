// Mirrors src-tauri/src/types.rs (camelCase, sats as numbers).

export interface PortStatus {
  reachable: boolean;
  error?: string;
}

export interface RpcSettings {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface CoreStatus {
  chain: string;
  blocks: number;
  headers: number;
  initialBlockDownload: boolean;
  synced: boolean;
  subversion: string;
  verificationProgress: number;
}

export interface VersionInfo {
  appVersion: string;
  coinswapSource: string;
}

// bootstrapProgress is informational only — coinswap's own init doesn't gate on it.
export interface TorStatus {
  reachable: boolean;
  authenticated: boolean;
  bootstrapProgress?: number;
  error?: string;
  /** Which tier `ensure_tor` used: "system" | "host_binary" | "embedded" | "none". */
  source?: string;
}

export type ConnectionType = "tor" | "clearnet";

export interface InitConfig {
  walletName: string;
  walletPassword?: string;
  controlPort?: number;
  socksPort?: number;
  torAuthPassword?: string;
  connectionType: ConnectionType;
  dataDir?: string;
}

export interface InitResult {
  walletName: string;
  dataDir: string;
  recoveryPending: boolean;
}

export interface WalletInfo {
  walletName: string;
  walletPath: string;
  dataDir: string;
}

// Mirrors src-tauri/src/error.rs — every failed invoke() rejects with this.
export interface AppError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "code" in e;
}

export type ErrorCode =
  | "RPC_UNREACHABLE"
  | "RPC_AUTH_FAILED"
  | "TOR_UNREACHABLE"
  | "ZMQ_UNREACHABLE"
  | "WALLET_NOT_FOUND"
  | "WALLET_WRONG_PASSWORD"
  | "WALLET_LOAD_FAILED"
  | "NOT_INITIALIZED"
  | "SWAP_IN_PROGRESS"
  | "INSUFFICIENT_FUNDS"
  | "NOT_ENOUGH_MAKERS"
  | "MAKER_NOT_FOUND"
  | "MAKER_NOT_INITIALIZED"
  | "MAKER_ALREADY_RUNNING"
  | "MAKER_NOT_RUNNING"
  | "MAKER_BUSY"
  | "REPORT_NOT_FOUND"
  | "CONTRACTS_BROADCASTED"
  | "INVALID_INPUT"
  | "STATE_POISONED"
  | "IO"
  | "INTERNAL";

// ---------------------------------------------------------------------------
// Wallet operations
// ---------------------------------------------------------------------------

export interface Balances {
  regular: number;
  swap: number;
  contract: number;
  fidelity: number;
  spendable: number;
}

export interface SwapLiquidity {
  spendable: number;
  regular: number;
  swap: number;
  maxSwappable: number;
}

export type AddressType = "p2wpkh" | "p2tr";

export interface NewAddress {
  address: string;
  addressType: string;
}

export interface AddressValidation {
  valid: boolean;
  error?: string;
}

export interface TxSummary {
  txid: string;
  category: string;
  amountSats: number;
  confirmations: number;
  address?: string;
  time: number;
  feeSats?: number;
  label?: string;
}

export interface UtxoEntry {
  txid: string;
  vout: number;
  amountSats: number;
  confirmations: number;
  address?: string;
  spendable: boolean;
  solvable: boolean;
  spendType: string;
}

export interface Outpoint {
  txid: string;
  vout: number;
}

export interface SendResult {
  txid: string;
}

export interface FeeEstimate {
  high: number;
  mid: number;
  low: number;
}

export interface PriceEstimate {
  usd: number;
}

// ---------------------------------------------------------------------------
// Market / offerbook
// ---------------------------------------------------------------------------

export interface Offer {
  baseFee: number;
  amountRelativeFeePct: number;
  timeRelativeFeePct: number;
  requiredConfirms: number;
  minimumLocktime: number;
  maxSize: number;
  minSize: number;
  bondAmountSats: number;
  bondLocktimeHeight: number;
  bondTxid: string;
  bondVout: number;
  bondIsSpent: boolean;
}

export interface Maker {
  address: string;
  protocol?: string;
  offer?: Offer;
  state: "good" | "bad" | "unresponsive";
}

export interface OfferBookView {
  good: Maker[];
  bad: Maker[];
  unresponsive: Maker[];
  syncing: boolean;
  lastSyncTs: number;
}

// ---------------------------------------------------------------------------
// Maker operations
// ---------------------------------------------------------------------------

export interface MakerSettings {
  makerId: string;
  walletName: string;
  networkPort: number;
  rpcPort: number;
  socksPort: number;
  controlPort: number;
  minSwapAmount: number;
  fidelityAmount: number;
  fidelityTimelock: number;
  requiredConfirms: number;
  baseFee: number;
  amountRelativeFeePct: number;
  timeRelativeFeePct: number;
  dataDir?: string;
}

export interface MakerInitConfig extends MakerSettings {
  walletPassword?: string;
  torAuthPassword?: string;
}

export interface SuggestedMakerPorts {
  networkPort: number;
  rpcPort: number;
}

export type MakerPhase =
  | { phase: "notConfigured" }
  | { phase: "initializing" }
  | { phase: "starting" }
  | { phase: "running" }
  | { phase: "stopping" }
  | { phase: "stopped" }
  | { phase: "failed"; message: string };

export interface MakerStatus {
  makerId: string;
  phase: MakerPhase;
  running: boolean;
  torAddress?: string;
  networkPort: number;
}

export interface FidelityBond {
  bondIndex: number;
  outpoint: Outpoint;
  amountSats: number;
  lockTimeHeight: number;
  isSpent: boolean;
  isLocked: boolean;
  bondValueSats?: number;
}

export interface MakerSwapReportSummary {
  swapId: string;
  status: string;
  startTimestamp: number;
  endTimestamp: number;
  incomingAmountSats: number;
  outgoingAmountSats: number;
  feeEarnedSats: number;
}

export interface MakerSwapReportDetail extends MakerSwapReportSummary {
  network: string;
  swapDurationSeconds: number;
  incomingContractTxid: string;
  outgoingContractTxid: string;
  timelock: number;
  deniabilityProof: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

export type ProtocolVersion = "legacy" | "taproot";

export interface SwapRequest {
  protocol: ProtocolVersion;
  amountSats: number;
  makerCount: number;
  outpoints?: Outpoint[];
  preferredMakers?: string[];
}

export interface SwapFundingEstimate {
  inputCount: number;
  vbytes: number;
  feeSats: number;
  feeRate: number;
  routeMiningFeePerMakerSats: number;
}

export interface MakerFeeInfo {
  address: string;
  protocol: string;
  baseFee: number;
  amountRelativeFeePct: number;
  timeRelativeFeePct: number;
  locktime: number;
  estimatedFeeSats: number;
}

export interface SwapSummary {
  swapId: string;
  protocol: string;
  sendAmountSats: number;
  makers: MakerFeeInfo[];
  totalEstimatedFeeSats: number;
  estimatedReceiveAmountSats: number;
}

// Coarse in-memory lifecycle — for live per-maker detail, see SwapTrackerProgress/getSwapTracker.
export type SwapPhase = "prepared" | "running" | "recovering" | "finished" | "failed";

export interface SwapProgress {
  swapId: string;
  phase: SwapPhase;
  startedAt?: number;
  error?: string;
}

export interface MakerProgress {
  address: string;
  stepsDone: number;
  stepsTotal: number;
}

export type TrackerPhase =
  | "makers_discovered"
  | "negotiated"
  | "funding_created"
  | "funds_broadcast"
  | "contracts_exchanged"
  | "finalizing"
  | "privkeys_forwarded"
  | "completed"
  | "failed";

// Read straight from the crate's own swap_tracker.cbor — same file the old Electron app polled.
export interface SwapTrackerProgress {
  phase: TrackerPhase;
  sendAmountSats: number;
  makerCount: number;
  failureReason?: string;
  makers: MakerProgress[];
}

export interface RecoveryStatus {
  recovering: boolean;
  complete: boolean;
  pendingContractCount: number;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type SwapStatus = "success" | "recovery_hashlock" | "recovery_timelock" | "failed";

export interface SwapReportSummary {
  swapId: string;
  status: SwapStatus;
  startTimestamp: number;
  endTimestamp: number;
  outgoingAmountSats: number;
  receivedAmountSats: number;
  feePaidSats: number;
  makersCount: number;
}

export interface MakerFeeInfo {
  makerIndex: number;
  makerAddress: string;
  baseFeeSats: number;
  amountRelativeFeeSats: number;
  timeRelativeFeeSats: number;
  totalFeeSats: number;
}

export interface SwapReportDetail {
  swapId: string;
  status: SwapStatus;
  network: string;
  swapDurationSeconds: number;
  startTimestamp: number;
  endTimestamp: number;
  errorMessage?: string;
  outgoingAmountSats: number;
  receivedAmountSats: number;
  feePaidSats: number;
  miningFeeSats: number;
  feePercentage: number;
  totalMakerFeesSats: number;
  outgoingContractTxid?: string;
  incomingContractTxid?: string;
  fundingTxids: string[][];
  makersCount: number;
  makerAddresses: string[];
  makerFeeInfo: MakerFeeInfo[];
  /** The exact outpoint verify_deniability checks on-chain. */
  provenOutpoint: Outpoint | null;
  /** Raw pass-through of the crate's DeniabilityProof (Taproot or Legacy variant) — rendered generically. */
  deniabilityProof: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogLine {
  line: string;
}
