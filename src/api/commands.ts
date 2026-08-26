import { invoke } from "@tauri-apps/api/core";
import type {
  AddressType,
  AddressValidation,
  Balances,
  BackendStatus,
  ChainBackendConfig,
  FeeEstimate,
  FidelityBond,
  InitConfig,
  InitResult,
  LogLine,
  Maker,
  MakerInitConfig,
  MakerSwapReportDetail,
  MakerSwapReportSummary,
  MakerPortCheck,
  MakerSettings,
  MakerStatus,
  NewAddress,
  OfferBookView,
  Outpoint,
  PortStatus,
  PriceEstimate,
  ProtocolVersion,
  RecoveryStatus,
  RestoreSelection,
  SendResult,
  SwapLiquidity,
  SwapFundingEstimate,
  SwapProgress,
  SwapReportDetail,
  SwapReportSummary,
  SwapRequest,
  SwapSummary,
  SwapTrackerProgress,
  SuggestedMakerPorts,
  TorStatus,
  TxSummary,
  UtxoEntry,
  VersionInfo,
  WalletInfo,
} from "./types";

export function checkCoreZmq(
  host: string,
  port: number,
): Promise<PortStatus> {
  return invoke("check_core_zmq", { host, port });
}

export function getChainBackend(): Promise<ChainBackendConfig> {
  return invoke("get_chain_backend");
}

export function setChainBackend(config: ChainBackendConfig): Promise<void> {
  return invoke("set_chain_backend", { config });
}

/** Clears the saved selection and returns the defaults it fell back to. */
export function resetChainBackend(): Promise<ChainBackendConfig> {
  return invoke("reset_chain_backend");
}

/**
 * Probes a chain backend. Pass `config` to test unsaved edits; omit it to probe
 * whichever backend is currently saved. `socksPort` only matters for a Tor-routed
 * Electrum server.
 */
export function checkBackend(config?: ChainBackendConfig, socksPort?: number): Promise<BackendStatus> {
  return invoke("check_backend", { config: config ?? null, socksPort });
}

export function checkTor(
  socksPort: number,
  controlPort: number,
  torAuthPassword: string,
): Promise<TorStatus> {
  return invoke("check_tor", { socksPort, controlPort, torAuthPassword });
}

export function getVersionInfo(): Promise<VersionInfo> {
  return invoke("get_version_info");
}

export function isWalletEncrypted(
  walletName: string,
  dataDir?: string,
): Promise<boolean> {
  return invoke("is_wallet_encrypted", { dataDir, walletName });
}

export function listWallets(dataDir?: string): Promise<string[]> {
  return invoke("list_wallets", { dataDir });
}

export function initTaker(config: InitConfig): Promise<InitResult> {
  return invoke("init_taker", { config });
}

export function shutdownTaker(): Promise<void> {
  return invoke("shutdown_taker");
}

export function getWalletInfo(): Promise<WalletInfo> {
  return invoke("get_wallet_info");
}

export function restoreWallet(
  walletName: string,
  socksPort: number | undefined,
  selectionId: string,
  password?: string,
  dataDir?: string,
): Promise<void> {
  return invoke("restore_wallet", {
    dataDir,
    walletName,
    socksPort,
    selectionId,
    password,
  });
}

export function chooseRestoreBackup(): Promise<RestoreSelection> {
  return invoke("choose_restore_backup");
}

export function backupWallet(
  password: string,
): Promise<string> {
  return invoke("backup_wallet", { password });
}

// ---------------------------------------------------------------------------
// Wallet operations
// ---------------------------------------------------------------------------

export function getBalances(): Promise<Balances> {
  return invoke("get_balances");
}

export function checkSwapLiquidity(): Promise<SwapLiquidity> {
  return invoke("check_swap_liquidity");
}

export function estimateSwapFunding(
  amountSats: number,
  protocol: ProtocolVersion,
  outpoints?: Outpoint[],
): Promise<SwapFundingEstimate> {
  return invoke("estimate_swap_funding", { amountSats, protocol, outpoints });
}

export function getNewAddress(addressType: AddressType): Promise<NewAddress> {
  return invoke("get_new_address", { addressType });
}

export function validateAddress(address: string): Promise<AddressValidation> {
  return invoke("validate_address", { address });
}

export function getTransactions(
  count?: number,
  skip?: number,
): Promise<TxSummary[]> {
  return invoke("get_transactions", { count, skip });
}

export function listUtxos(): Promise<UtxoEntry[]> {
  return invoke("list_utxos");
}

export function sendToAddress(
  address: string,
  amountSats: number,
  feeRate?: number,
  outpoints?: Outpoint[],
): Promise<SendResult> {
  return invoke("send_to_address", { address, amountSats, feeRate, outpoints });
}

export function syncWallet(): Promise<void> {
  return invoke("sync_wallet");
}

export function estimateFees(): Promise<FeeEstimate> {
  return invoke("estimate_fees");
}

export function getBtcPrice(): Promise<PriceEstimate> {
  return invoke("get_btc_price");
}

// ---------------------------------------------------------------------------
// Market / offerbook
// ---------------------------------------------------------------------------

export function getOffers(): Promise<OfferBookView> {
  return invoke("get_offers");
}

export function syncOfferbook(): Promise<void> {
  return invoke("sync_offerbook");
}

export function pollMaker(address: string): Promise<Maker> {
  return invoke("poll_maker", { address });
}

export function removeMaker(address: string): Promise<boolean> {
  return invoke("remove_maker", { address });
}

// ---------------------------------------------------------------------------
// Maker operations
// ---------------------------------------------------------------------------

export function listMakers(): Promise<MakerSettings[]> {
  return invoke("list_makers");
}

export function listDashboardImports(): Promise<MakerSettings[]> {
  return invoke("list_dashboard_imports");
}

export function importDashboardMakers(makerIds: string[]): Promise<MakerSettings[]> {
  return invoke("import_dashboard_makers", { makerIds });
}

export function getMakerStatus(makerId: string): Promise<MakerStatus> {
  return invoke("get_maker_status", { makerId });
}

export function initMaker(config: MakerInitConfig): Promise<MakerStatus> {
  return invoke("init_maker", { config });
}

export function updateMakerSettings(makerId: string, settings: MakerSettings): Promise<MakerSettings> {
  return invoke("update_maker_settings", { makerId, settings });
}

export function startMaker(
  makerId: string,
  walletPassword?: string,
  torAuthPassword?: string,
): Promise<void> {
  return invoke("start_maker", { makerId, walletPassword, torAuthPassword });
}

export function stopMaker(makerId: string): Promise<void> {
  return invoke("stop_maker", { makerId });
}

export function getMakerInfo(makerId: string): Promise<WalletInfo> {
  return invoke("get_maker_info", { makerId });
}

export function getSavedMakerSettings(makerId: string): Promise<MakerSettings | null> {
  return invoke("get_saved_maker_settings", { makerId });
}

export function clearMakerSettings(makerId: string): Promise<void> {
  return invoke("clear_maker_settings", { makerId });
}

export function getSuggestedMakerPorts(socksPort: number, controlPort: number): Promise<SuggestedMakerPorts> {
  return invoke("get_suggested_maker_ports", { socksPort, controlPort });
}

/** Verifies a maker's listener ports are bindable and unclaimed. Empty result means both are fine. */
export function checkMakerPorts(
  networkPort: number,
  rpcPort: number,
  socksPort: number,
  controlPort: number,
): Promise<MakerPortCheck> {
  return invoke("check_maker_ports", { networkPort, rpcPort, socksPort, controlPort });
}

export function getMakerBalances(makerId: string): Promise<Balances> {
  return invoke("get_maker_balances", { makerId });
}

export function listMakerUtxos(makerId: string): Promise<UtxoEntry[]> {
  return invoke("list_maker_utxos", { makerId });
}

export function getMakerTransactions(makerId: string, count?: number, skip?: number): Promise<TxSummary[]> {
  return invoke("get_maker_transactions", { makerId, count, skip });
}

export function getMakerNewAddress(makerId: string, addressType: AddressType): Promise<NewAddress> {
  return invoke("get_maker_new_address", { makerId, addressType });
}

export function syncMakerWallet(makerId: string): Promise<void> {
  return invoke("sync_maker_wallet", { makerId });
}

export function listMakerFidelityBonds(makerId: string): Promise<FidelityBond[]> {
  return invoke("list_maker_fidelity_bonds", { makerId });
}

export function listMakerSwapReports(makerId: string): Promise<MakerSwapReportSummary[]> {
  return invoke("list_maker_swap_reports", { makerId });
}

export function getMakerSwapReport(makerId: string, swapId: string): Promise<MakerSwapReportDetail> {
  return invoke("get_maker_swap_report", { makerId, swapId });
}

export function verifyMakerDeniability(makerId: string, swapId: string): Promise<boolean> {
  return invoke("verify_maker_deniability", { makerId, swapId });
}

export function getMakerLogs(makerId: string, lines?: number): Promise<LogLine[]> {
  return invoke("get_maker_logs", { makerId, lines });
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

export function prepareSwap(request: SwapRequest): Promise<SwapSummary> {
  return invoke("prepare_swap", { request });
}

// Result arrives via the "swap://finished" / "swap://failed" events (see
// src-tauri/src/commands/swap.rs); poll getSwapProgress for a snapshot.
export function startSwap(swapId: string): Promise<void> {
  return invoke("start_swap", { swapId });
}

export function getSwapProgress(): Promise<SwapProgress | null> {
  return invoke("get_swap_progress");
}

// Live per-maker detail read straight from swap_tracker.cbor — poll this every couple seconds
// while a swap is running, same cadence as the old Electron app's disk-read poll.
export function getSwapTracker(): Promise<SwapTrackerProgress | null> {
  return invoke("get_swap_tracker");
}

export function recoverSwap(): Promise<void> {
  return invoke("recover_swap");
}

export function getRecoveryStatus(): Promise<RecoveryStatus> {
  return invoke("get_recovery_status");
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function listSwapReports(): Promise<SwapReportSummary[]> {
  return invoke("list_swap_reports");
}

export function getSwapReport(swapId: string): Promise<SwapReportDetail> {
  return invoke("get_swap_report", { swapId });
}

export function verifyDeniability(swapId: string): Promise<boolean> {
  return invoke("verify_deniability", { swapId });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function getLogs(lines?: number): Promise<LogLine[]> {
  return invoke("get_logs", { lines });
}
