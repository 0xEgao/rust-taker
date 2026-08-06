//! Serde DTOs crossing the IPC boundary. Mirrored by `src/api/types.ts`.
//! Conventions: camelCase field names, amounts in sats as u64.

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortStatus {
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcSettings {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub chain: String,
    pub blocks: u64,
    pub headers: u64,
    pub initial_block_download: bool,
    /// true when headers == blocks and IBD is over
    pub synced: bool,
    /// Core's version string, e.g. "/Satoshi:27.0.0/".
    pub subversion: String,
    /// [0..1] estimate of chain verification progress.
    pub verification_progress: f64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub app_version: String,
    pub coinswap_source: String,
}

/// bootstrapProgress is informational only — init doesn't gate on it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorStatus {
    pub reachable: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap_progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// "system" | "host_binary" | "embedded" | "none" — which tier `tor::ensure_tor` used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionTypeDto {
    Tor,
    Clearnet,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitConfig {
    pub wallet_name: String,
    #[serde(default)]
    pub wallet_password: Option<String>,
    #[serde(default)]
    pub control_port: Option<u16>,
    #[serde(default)]
    pub socks_port: Option<u16>,
    #[serde(default)]
    pub tor_auth_password: Option<String>,
    pub connection_type: ConnectionTypeDto,
    #[serde(default)]
    pub data_dir: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub wallet_name: String,
    pub data_dir: String,
    /// True if the wallet has live (unfinished) contract UTXOs after init.
    pub recovery_pending: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletInfo {
    pub wallet_name: String,
    pub wallet_path: String,
    pub data_dir: String,
}

// ---------------------------------------------------------------------------
// Wallet operations
// ---------------------------------------------------------------------------

/// Mirrors coinswap's `Balances` (all amounts in sats).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalancesDto {
    pub regular: u64,
    pub swap: u64,
    pub contract: u64,
    pub fidelity: u64,
    pub spendable: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapLiquidity {
    pub spendable: u64,
    pub regular: u64,
    pub swap: u64,
    /// max(regular, swap) minus a dust buffer, matching the old app's rule.
    pub max_swappable: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddressTypeDto {
    P2wpkh,
    P2tr,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAddress {
    pub address: String,
    pub address_type: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressValidation {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Condensed from `bitcoind::bitcoincore_rpc::json::ListTransactionResult`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxSummary {
    pub txid: String,
    pub category: String,
    /// Signed: negative for outgoing, positive for incoming.
    pub amount_sats: i64,
    pub confirmations: i32,
    pub address: Option<String>,
    pub time: u64,
    pub fee_sats: Option<i64>,
    /// Core's wallet label for the receiving output, e.g. "watchonly_swapcoin".
    pub label: Option<String>,
}

/// One UTXO plus its coinswap-specific spend-type classification.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoEntry {
    pub txid: String,
    pub vout: u32,
    pub amount_sats: u64,
    pub confirmations: u32,
    pub address: Option<String>,
    pub spendable: bool,
    pub solvable: bool,
    /// Human category from coinswap's `UTXOSpendInfo` Display impl, e.g.
    /// "regular", "incoming swap", "outgoing swap", "timelock contract",
    /// "hashlock contract", "fidelity bond", "swept".
    pub spend_type: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outpoint {
    pub txid: String,
    pub vout: u32,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub txid: String,
}

/// Structured equivalent of the crate's `Wallet::display_fidelity_bonds` string dump —
/// `Wallet::get_fidelity_bonds()`/`calculate_bond_value` already expose everything needed
/// directly, no coinswap-side change required (see `.claude/MAKER_INTEGRATION.md` §4).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FidelityBondDto {
    pub bond_index: u32,
    pub outpoint: Outpoint,
    pub amount_sats: u64,
    /// Absolute block height the bond unlocks at.
    pub lock_time_height: u32,
    pub is_spent: bool,
    /// Not yet unlocked and not already redeemed.
    pub is_locked: bool,
    /// Coinswap's theoretical fidelity-value formula — only computable for a confirmed,
    /// unspent bond, hence optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bond_value_sats: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeEstimate {
    pub high: f64,
    pub mid: f64,
    pub low: f64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceEstimate {
    pub usd: f64,
}

// ---------------------------------------------------------------------------
// Market / offerbook
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferDto {
    pub base_fee: u64,
    pub amount_relative_fee_pct: f64,
    pub time_relative_fee_pct: f64,
    pub required_confirms: u32,
    pub minimum_locktime: u16,
    pub max_size: u64,
    pub min_size: u64,
    pub bond_amount_sats: u64,
    /// Absolute block height the bond unlocks at.
    pub bond_locktime_height: u32,
    pub bond_txid: String,
    pub bond_vout: u32,
    pub bond_is_spent: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerDto {
    pub address: String,
    /// "legacy" | "taproot" | null (protocol unknown until an offer is fetched)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offer: Option<OfferDto>,
    /// "good" | "bad" | "unresponsive"
    pub state: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferBookView {
    pub good: Vec<MakerDto>,
    pub bad: Vec<MakerDto>,
    pub unresponsive: Vec<MakerDto>,
    pub syncing: bool,
    pub last_sync_ts: u64,
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolVersionDto {
    Legacy,
    Taproot,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapRequest {
    pub protocol: ProtocolVersionDto,
    pub amount_sats: u64,
    pub maker_count: usize,
    #[serde(default)]
    pub outpoints: Option<Vec<Outpoint>>,
    #[serde(default)]
    pub preferred_makers: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapFundingEstimateDto {
    pub input_count: usize,
    pub vbytes: u64,
    pub fee_sats: u64,
    pub fee_rate: f64,
    pub route_mining_fee_per_maker_sats: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerFeeInfoDto {
    pub address: String,
    pub protocol: String,
    pub base_fee: u64,
    pub amount_relative_fee_pct: f64,
    pub time_relative_fee_pct: f64,
    pub locktime: u16,
    pub estimated_fee_sats: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapSummaryDto {
    pub swap_id: String,
    pub protocol: String,
    pub send_amount_sats: u64,
    pub makers: Vec<MakerFeeInfoDto>,
    pub total_estimated_fee_sats: u64,
    pub estimated_receive_amount_sats: u64,
}

/// Coarse in-memory lifecycle snapshot (survives across commands via `AppState.active_swap`).
/// For live per-maker detail, see `SwapTrackerDto` / `get_swap_tracker`, which reads the crate's
/// own `swap_tracker.cbor` — the same file the old Electron app polled directly off disk.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapProgressDto {
    pub swap_id: String,
    /// "prepared" | "running" | "finished" | "failed"
    pub phase: String,
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerProgressDto {
    pub address: String,
    pub steps_done: usize,
    pub steps_total: usize,
}

/// Live per-maker detail read straight from `coinswap::taker::swap_tracker::SwapTracker`
/// (a public crate API — see `commands::taker_swap`'s module doc).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapTrackerDto {
    /// "makers_discovered" | "negotiated" | "funding_created" | "funds_broadcast" |
    /// "contracts_exchanged" | "finalizing" | "privkeys_forwarded" | "completed" | "failed"
    pub phase: String,
    // send_amount_sats/maker_count let the frontend rebuild its progress screen after remounting
    // mid-swap (e.g. navigating away and back) without a cached SwapSummary — prepareSwap only
    // ever returns one, and re-running it isn't possible for an already-running swap.
    pub send_amount_sats: u64,
    pub maker_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    pub makers: Vec<MakerProgressDto>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub recovering: bool,
    pub complete: bool,
    pub pending_contract_count: usize,
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapReportSummary {
    pub swap_id: String,
    /// "success" | "recovery_hashlock" | "recovery_timelock" | "failed"
    pub status: String,
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    pub outgoing_amount_sats: u64,
    /// outgoing_amount_sats - fee_paid_sats — the crate's own incoming_amount can be inconsistent
    /// for non-Success outcomes, so this is derived here rather than passed through.
    pub received_amount_sats: u64,
    pub fee_paid_sats: u64,
    pub makers_count: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerFeeInfo {
    pub maker_index: usize,
    pub maker_address: String,
    pub base_fee_sats: f64,
    pub amount_relative_fee_sats: f64,
    pub time_relative_fee_sats: f64,
    pub total_fee_sats: f64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapReportDetail {
    pub swap_id: String,
    pub status: String,
    pub network: String,
    pub swap_duration_seconds: f64,
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub outgoing_amount_sats: u64,
    /// outgoing_amount_sats - fee_paid_sats — see the same field's doc on `SwapReportSummary`.
    pub received_amount_sats: u64,
    pub fee_paid_sats: u64,
    pub mining_fee_sats: u64,
    pub fee_percentage: f64,
    pub total_maker_fees_sats: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outgoing_contract_txid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incoming_contract_txid: Option<String>,
    pub funding_txids: Vec<Vec<String>>,
    pub makers_count: usize,
    pub maker_addresses: Vec<String>,
    pub maker_fee_info: Vec<MakerFeeInfo>,
    pub input_utxo_amounts_sats: Vec<u64>,
    pub output_change_utxos: Vec<(u64, String)>,
    pub output_swap_utxos: Vec<(u64, String)>,
    /// The exact outpoint `verify_deniability` checks on-chain — the one field of the proof the
    /// UI reasons about, so it's typed rather than pulled out of the raw JSON below.
    pub proven_outpoint: Option<Outpoint>,
    /// Raw pass-through of the crate's `DeniabilityProof` (already `Serialize`) rather than
    /// hand-mirrored types — the frontend renders whatever shape comes through generically.
    pub deniability_proof: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Maker
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerInitConfig {
    /// Stable registration ID. Wallet name remains independently configurable.
    pub maker_id: String,
    pub wallet_name: String,
    #[serde(default)]
    pub wallet_password: Option<String>,
    pub network_port: u16,
    pub rpc_port: u16,
    pub socks_port: u16,
    pub control_port: u16,
    #[serde(default)]
    pub tor_auth_password: Option<String>,
    pub min_swap_amount: u64,
    pub fidelity_amount: u64,
    pub fidelity_timelock: u32,
    pub required_confirms: u32,
    pub base_fee: u64,
    pub amount_relative_fee_pct: f64,
    pub time_relative_fee_pct: f64,
    #[serde(default)]
    pub data_dir: Option<String>,
}

/// Persisted registration settings. Wallet and Tor control passwords are
/// process-only and omitted when this DTO is serialized to disk.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerSettingsDto {
    pub maker_id: String,
    pub wallet_name: String,
    pub network_port: u16,
    pub rpc_port: u16,
    pub socks_port: u16,
    pub control_port: u16,
    /// Process-only credential. Deserialized for IPC but never written into
    /// persisted maker registrations.
    #[serde(default, skip_serializing)]
    pub tor_auth_password: Option<String>,
    pub min_swap_amount: u64,
    pub fidelity_amount: u64,
    pub fidelity_timelock: u32,
    pub required_confirms: u32,
    pub base_fee: u64,
    pub amount_relative_fee_pct: f64,
    pub time_relative_fee_pct: f64,
    #[serde(default)]
    pub data_dir: Option<String>,
}

impl MakerSettingsDto {
    pub fn from_init(c: &MakerInitConfig, data_dir: &std::path::Path) -> Self {
        Self {
            maker_id: c.maker_id.clone(),
            wallet_name: c.wallet_name.clone(),
            network_port: c.network_port,
            rpc_port: c.rpc_port,
            socks_port: c.socks_port,
            control_port: c.control_port,
            tor_auth_password: c.tor_auth_password.clone(),
            min_swap_amount: c.min_swap_amount,
            fidelity_amount: c.fidelity_amount,
            fidelity_timelock: c.fidelity_timelock,
            required_confirms: c.required_confirms,
            base_fee: c.base_fee,
            amount_relative_fee_pct: c.amount_relative_fee_pct,
            time_relative_fee_pct: c.time_relative_fee_pct,
            data_dir: Some(data_dir.display().to_string()),
        }
    }

    pub fn into_init(self, wallet_password: Option<String>) -> MakerInitConfig {
        MakerInitConfig {
            maker_id: self.maker_id,
            wallet_name: self.wallet_name,
            wallet_password,
            network_port: self.network_port,
            rpc_port: self.rpc_port,
            socks_port: self.socks_port,
            control_port: self.control_port,
            tor_auth_password: self.tor_auth_password,
            min_swap_amount: self.min_swap_amount,
            fidelity_amount: self.fidelity_amount,
            fidelity_timelock: self.fidelity_timelock,
            required_confirms: self.required_confirms,
            base_fee: self.base_fee,
            amount_relative_fee_pct: self.amount_relative_fee_pct,
            time_relative_fee_pct: self.time_relative_fee_pct,
            data_dir: self.data_dir,
        }
    }
}

/// Coarse lifecycle for one entry in `AppState.makers`, pushed through a
/// maker-ID-tagged `maker://phase-changed` event.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "phase")]
pub enum MakerPhase {
    #[default]
    NotConfigured,
    Initializing,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerPhaseEvent {
    pub maker_id: String,
    pub phase: MakerPhase,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerStatusDto {
    pub maker_id: String,
    pub phase: MakerPhase,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tor_address: Option<String>,
    pub network_port: u16,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedMakerPortsDto {
    pub network_port: u16,
    pub rpc_port: u16,
}

/// The maker's own perspective on one swap — one leg, not the whole
/// multi-hop route a `SwapReportSummary`/`SwapReportDetail` (taker-side)
/// describes, so this is a separate, simpler shape rather than reusing
/// those. Mirrors `coinswap::wallet::MakerReport`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerSwapReportSummary {
    pub swap_id: String,
    pub status: String,
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    pub incoming_amount_sats: u64,
    pub outgoing_amount_sats: u64,
    pub fee_earned_sats: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerSwapReportDetail {
    pub swap_id: String,
    pub status: String,
    pub network: String,
    pub swap_duration_seconds: f64,
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    pub incoming_amount_sats: u64,
    pub outgoing_amount_sats: u64,
    pub fee_earned_sats: u64,
    pub incoming_contract_txid: String,
    pub outgoing_contract_txid: String,
    pub timelock: u32,
    /// Raw pass-through of the crate's `DeniabilityProof` — see the same
    /// field's doc comment on `SwapReportDetail`.
    pub deniability_proof: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub line: String,
}
