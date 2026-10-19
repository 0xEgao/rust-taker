/**
 * A stand-in for Portal's web API, installed with `page.route`. The UI suites run against it so
 * every screen can be put in an exact state — a funded wallet, a failed swap, a router mid-start —
 * without a chain, Tor or a counterparty.
 *
 * Every response is typed against `src/api/types.ts`, so a wire-type change that the fake no longer
 * satisfies fails `tsc` here rather than drifting silently. `contract.spec.ts` keeps the command
 * table in step with `contracts/operations.json`.
 */
import { readFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import type { UnresolvedOperation } from "../../src/api/host-contract";
import type {
  AppError,
  Balances,
  ChainBackendConfig,
  ElectrumPreset,
  OfferBookView,
  RecoveryPhrase,
  RecoveryStatus,
  RecoverySummary,
  RouterDefaults,
  RouterSettings,
  RouterStatus,
  SwapReportDetail,
  SwapReportSummary,
  SwapProgress,
  SwapSummary,
  SwapTrackerProgress,
  TorStatus,
  TxSummary,
  UtxoEntry,
  WalletAddress,
  WalletListing,
} from "../../src/api/types";

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

/** Thrown from a handler to answer with an `AppError` instead of a result. */
export class FakeError {
  constructor(
    readonly error: AppError,
    readonly status = 400,
  ) {}
}

export const fail = (code: AppError["code"], message: string, status = 400) =>
  new FakeError({ code, message }, status);

export const OWNER_PASSWORD = "correct horse battery";
export const WALLET_NAME = "e2e-wallet";
export const WALLET_PASSWORD = "wallet-password";
/** The password inside the backup file the restore tests upload. */
export const BACKUP_PASSWORD = "backup-password";
export const ROUTER_ID = "e2e-router";

const TXID = (n: number) => n.toString(16).padStart(64, "0");
const ADDRESS = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
const NOW = 1_760_000_000;

/** What the fake remembers between calls. Tests set it before `page.goto`. */
export interface FakeState {
  hasOwner: boolean;
  authenticated: boolean;
  connected: boolean;
  wallet: { name: string; dataDir: string } | null;
  wallets: WalletListing[];
  /** Each wallet's password, by name. */
  walletPasswords: Record<string, string>;
  pendingPhrase: RecoveryPhrase | null;
  balances: Balances;
  transactions: TxSummary[];
  routers: RouterSettings[];
  routerStatus: Record<string, RouterStatus>;
  tor: TorStatus;
  /** The swap `prepare_swap` last quoted, then the one `start_swap` is running. */
  swap: { progress: SwapProgress; tracker: SwapTrackerProgress; running: boolean } | null;
  recoveries: RecoverySummary[];
  /** What `get_recovery_status` reports; idle when null. */
  recovery: RecoveryStatus | null;
  /** Payments whose outcome is unknown, holding up new spending. */
  blocking: UnresolvedOperation[];
  /** False answers `GET /operations` with a server error instead of a list. */
  journalReadable: boolean;
}

/** Mirrors `OperationRecord` in `core/src/operations.rs`, as far as the client reads it. */
export interface OperationRecord {
  state: "accepted" | "running" | "succeeded" | "failed" | "indeterminate";
  result?: unknown;
  error?: AppError;
}

const routerSettings = (id: string): RouterSettings => ({
  routerId: id,
  walletName: `${id}-wallet`,
  name: "E2E router",
  networkPort: 6102,
  rpcPort: 6103,
  socksPort: 9050,
  controlPort: 9051,
  fidelityAmount: 50_000,
  fidelityTimelock: 950,
  fidelityFeerate: 2,
  requiredConfirms: 1,
  baseFee: 100,
  amountRelativeFeePct: 0.1,
  timeRelativeFeePct: 0.005,
  network: "signet",
});

export const PHRASE: RecoveryPhrase = {
  id: "phrase-1",
  words:
    "abandon ability able about above absent absorb abstract absurd abuse access accident",
};

export function defaultState(): FakeState {
  return {
    hasOwner: true,
    authenticated: true,
    connected: true,
    wallet: { name: WALLET_NAME, dataDir: "/data" },
    wallets: [{ name: WALLET_NAME, network: "signet" }],
    walletPasswords: { [WALLET_NAME]: WALLET_PASSWORD },
    pendingPhrase: null,
    balances: { regular: 1_250_000, swap: 300_000, contract: 0, fidelity: 0, spendable: 1_550_000 },
    transactions: [
      {
        txid: TXID(1),
        category: "receive",
        amountSats: 1_250_000,
        confirmations: 12,
        address: ADDRESS,
        time: NOW - 3600,
        firstSeen: NOW - 3600,
      },
      {
        txid: TXID(2),
        category: "send",
        amountSats: -100_000,
        confirmations: 3,
        address: ADDRESS,
        time: NOW - 600,
        feeSats: 210,
        firstSeen: NOW - 600,
      },
    ],
    routers: [routerSettings(ROUTER_ID)],
    routerStatus: {
      [ROUTER_ID]: {
        routerId: ROUTER_ID,
        phase: { phase: "running" },
        running: true,
        torAddress: "e2erouteraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion:6102",
        networkPort: 6102,
        walletEncrypted: true,
        hasBond: true,
      },
    },
    tor: {
      reachable: true,
      socksReachable: true,
      authenticated: true,
      bootstrapProgress: 100,
      bootstrapSummary: "Done",
      socksPort: 19050,
      controlPort: 19051,
    },
    swap: null,
    recoveries: [],
    recovery: null,
    blocking: [],
    journalReadable: true,
  };
}

const presets: ElectrumPreset[] = [
  { label: "Portal signet", url: "ssl://signet.example:50002", network: "signet" },
  { label: "Mainnet", url: "ssl://mainnet.example:50002", network: "bitcoin" },
];

const chainBackend: ChainBackendConfig = {
  kind: "electrum",
  electrum: { url: presets[0].url, useTor: true },
  node: { host: "127.0.0.1", port: 38332, username: "user", password: "", zmqPort: 28332 },
};

const routerDefaults: RouterDefaults = {
  fidelityAmount: 50_000,
  minFidelityAmount: 10_000,
  fidelityTimelock: 950,
  fidelityFeerate: 2,
  requiredConfirms: 1,
  baseFee: 100,
  amountRelativeFeePct: 0.1,
  timeRelativeFeePct: 0.005,
};

const offers: OfferBookView = {
  syncing: false,
  bad: [],
  unresponsive: [],
  good: [1, 2, 3].map((n) => ({
    address: `router${n}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion:6102`,
    protocol: "taproot",
    state: "good" as const,
    offer: {
      name: `Router ${n}`,
      baseFee: 100 * n,
      amountRelativeFeePct: 0.1,
      timeRelativeFeePct: 0.005,
      requiredConfirms: 1,
      maxSize: 5_000_000,
      minSize: 10_000,
      bondAmountSats: 100_000 * n,
      bondLocktimeHeight: 250_000,
      bondTxid: TXID(100 + n),
      bondVout: 0,
      bondIsSpent: false,
    },
  })),
};

const addresses: WalletAddress[] = [
  {
    address: ADDRESS,
    addressType: "p2wpkh",
    change: false,
    derivationPath: "m/84'/1'/0'/0/0",
    balanceSats: 1_250_000,
    unconfirmed: false,
  },
];

const utxos: UtxoEntry[] = [
  {
    txid: TXID(1),
    vout: 0,
    amountSats: 1_250_000,
    confirmations: 12,
    address: ADDRESS,
    derivationPath: "m/84'/1'/0'/0/0",
    spendable: true,
    solvable: true,
    spendType: "seed",
  },
];

export const SWAP_ID = "a1b2c3d4e5f6";

const swapSummary = (amountSats: number): SwapSummary => ({
  swapId: SWAP_ID,
  protocol: "taproot",
  sendAmountSats: amountSats,
  routers: offers.good.slice(0, 2).map((r) => ({
    address: r.address,
    protocol: "taproot",
    baseFee: r.offer!.baseFee,
    amountRelativeFeePct: 0.1,
    timeRelativeFeePct: 0.005,
    locktime: 20,
    estimatedFeeSats: 400,
  })),
  totalEstimatedFeeSats: 1_800,
  estimatedReceiveAmountSats: amountSats - 1_800,
  routerFeeSats: 800,
  miningFeeSats: 1_000,
});

const tracker = (summary: SwapSummary): SwapTrackerProgress => ({
  phase: "funds_broadcast",
  sendAmountSats: summary.sendAmountSats,
  routerCount: summary.routers.length,
  routers: summary.routers.map((r) => ({ address: r.address, stage: "confirming", milestones: [] })),
  outgoingContractTxids: [TXID(10)],
  incomingContractTxids: [],
  watchonlyContractTxids: [],
  outgoingConfirmed: false,
  protocol: "taproot",
  fundingWaitTxids: [[TXID(10)]],
});

const reportSummary: SwapReportSummary = {
  swapId: SWAP_ID,
  status: "success",
  reported: true,
  startTimestamp: NOW - 7200,
  endTimestamp: NOW - 6900,
  outgoingAmountSats: 200_000,
  receivedAmountSats: 198_200,
  feePaidSats: 1_800,
  routersCount: 2,
};

const reportDetail: SwapReportDetail = {
  ...reportSummary,
  endTimestamp: NOW - 6900,
  network: "signet",
  swapDurationSeconds: 300,
  miningFeeSats: 1_000,
  feePercentage: 0.9,
  totalRouterFeesSats: 800,
  outgoingUtxos: [{ address: ADDRESS, valueSats: 200_000 }],
  incomingUtxos: [{ address: ADDRESS, valueSats: 198_200 }],
  fundingTxids: [[TXID(10)], [TXID(11)]],
  routerAddresses: offers.good.slice(0, 2).map((r) => r.address),
  routerFeeInfo: [
    { routerIndex: 0, baseFeeSats: 100, amountRelativeFeeSats: 200, timeRelativeFeeSats: 100, totalFeeSats: 400 },
    { routerIndex: 1, baseFeeSats: 200, amountRelativeFeeSats: 100, timeRelativeFeeSats: 100, totalFeeSats: 400 },
  ],
  paySwap: false,
  deniabilityProof: null,
  raw: "{}",
};

const idleRecovery: RecoveryStatus = {
  active: false,
  phase: "not_started",
  routerCount: 0,
  sendAmountSats: 0,
  swapReceived: false,
  pending: [],
  resolved: [],
  lockedSats: 0,
  routerOwedSats: 0,
};

/** Operations on the web contract that are not `/commands/{name}` routes. */
export const NOT_COMMAND_ROUTES = ["backup_wallet", "backup_maker_wallet"];

export const CONTRACT = (
  JSON.parse(readFileSync("contracts/operations.json", "utf8")) as {
    operations: { name: string; web: boolean; executionClass: string }[];
  }
).operations;

/** Answered with a 202 and a journal record, as the web host answers them. */
const DURABLE = new Set(CONTRACT.filter((op) => op.web && op.executionClass === "durable").map((op) => op.name));

function defaultHandlers(s: FakeState): Record<string, Handler> {
  const requireWallet = () => {
    if (!s.wallet) throw fail("NOT_INITIALIZED", "no wallet is open");
  };
  const router = (args: Args) => {
    const id = String(args.routerId);
    const settings = s.routers.find((r) => r.routerId === id);
    if (!settings) throw fail("ROUTER_NOT_FOUND", `no router ${id}`, 404);
    return settings;
  };

  return {
    // Connection gate
    check_tor: () => s.tor,
    restart_tor_bootstrap: () => null,
    get_chain_backend: () => chainBackend,
    get_electrum_presets: () => presets,
    set_chain_backend: () => {
      s.connected = true;
      return null;
    },
    check_backend: () => ({ reachable: true, synced: true, chain: "signet", blocks: 250_000 }),

    // Wallet lifecycle
    list_wallets: () => s.wallets,
    init_taker: (args) => {
      const config = args.config as { walletName: string; walletPassword?: string };
      const known = config.walletName in s.walletPasswords;
      if (known && config.walletPassword !== s.walletPasswords[config.walletName]) {
        throw fail("WALLET_WRONG_PASSWORD", "wrong wallet password");
      }
      if (!known) {
        s.wallets.push({ name: config.walletName, network: "signet" });
        s.walletPasswords[config.walletName] = config.walletPassword ?? "";
        s.pendingPhrase = PHRASE;
      }
      s.wallet = { name: config.walletName, dataDir: "/data" };
      return { walletName: config.walletName, dataDir: "/data", joined: false };
    },
    shutdown_taker: () => {
      s.wallet = null;
      return null;
    },
    get_session_state: () => ({
      initialized: s.wallet !== null,
      connected: s.connected,
      walletName: s.wallet?.name ?? null,
      dataDir: s.wallet?.dataDir ?? null,
    }),
    get_wallet_info: () => {
      requireWallet();
      return { walletName: s.wallet!.name, walletPath: "wallet", dataDir: s.wallet!.dataDir };
    },
    // A restore writes the wallet; `init_taker` then opens it with the same password.
    restore_wallet: (args) => {
      if (args.selectionId !== "upload-1") throw fail("INVALID_FILE_SELECTION", "no such upload");
      if (args.password !== BACKUP_PASSWORD) throw fail("WALLET_WRONG_PASSWORD", "wrong backup password");
      s.wallets.push({ name: String(args.walletName), network: "signet" });
      s.walletPasswords[String(args.walletName)] = BACKUP_PASSWORD;
      return null;
    },
    restore_wallet_from_mnemonic: (args) => {
      if (String(args.mnemonic).split(" ").length !== 12) throw fail("INVALID_INPUT", "invalid recovery phrase");
      s.wallets.push({ name: String(args.walletName), network: "signet" });
      s.walletPasswords[String(args.walletName)] = String(args.password);
      return null;
    },
    get_recovery_phrase: () => s.pendingPhrase,
    confirm_recovery_phrase_saved: (args) => {
      if (s.pendingPhrase?.id === args.id) s.pendingPhrase = null;
      return null;
    },

    // Wallet reads
    get_balances: () => (requireWallet(), s.balances),
    validate_address: (args) =>
      /^(tb1|bc1|bcrt1)[a-z0-9]{20,}$/.test(String(args.address))
        ? { valid: true }
        : { valid: false, error: "not a valid address" },
    get_new_address: (args) => ({
      address: ADDRESS,
      addressType: String(args.addressType),
      derivationPath: "m/84'/1'/0'/0/1",
    }),
    get_transactions: () => s.transactions,
    list_addresses: () => addresses,
    list_utxos: () => utxos,
    send_to_address: (args) => {
      const amount = Number(args.amountSats);
      if (amount > s.balances.spendable) throw fail("INSUFFICIENT_FUNDS", "insufficient funds");
      return { txid: TXID(99) };
    },
    sync_wallet: () => null,
    estimate_fees: () => ({ fast: 12, medium: 6, slow: 2 }),
    get_btc_price: () => ({ usd: 100_000, cached: false, fetchedAt: NOW }),
    estimate_send_fee: () => ({ feeSats: 210, vsize: 141, inputs: 1 }),
    estimate_swap_funding: () => ({
      inputCount: 1,
      vbytes: 200,
      feeSats: 400,
      outgoingUtxoCount: 1,
      incomingUtxoCount: 2,
      routeMiningFeePerRouterSats: 300,
      sweepFeeSats: 200,
      receiveDustSats: 330,
    }),

    // Market
    get_offers: () => offers,
    sync_offerbook: () => null,
    poll_maker: (args) => offers.good.find((r) => r.address === args.address) ?? offers.good[0],
    remove_maker: () => true,

    // Swap
    prepare_swap: (args) => {
      const summary = swapSummary(Number((args.request as { amountSats: number }).amountSats));
      s.swap = { progress: { swapId: summary.swapId, summary }, tracker: tracker(summary), running: false };
      return summary;
    },
    start_swap: () => {
      if (!s.swap) throw fail("INVALID_INPUT", "no prepared swap");
      s.swap.running = true;
      s.swap.progress.startedAt = Math.floor(Date.now() / 1000);
      return null;
    },
    cancel_swap: () => null,
    get_swap_progress: () => (s.swap?.running ? s.swap.progress : null),
    get_swap_tracker: () => s.swap?.tracker ?? null,
    get_swap_preparation: () => null,
    recover_swap: () => null,
    get_recovery_status: () => s.recovery ?? idleRecovery,
    list_recoveries: () => s.recoveries,
    list_swap_reports: () => [reportSummary],
    get_swap_report: (args) => {
      if (args.swapId !== SWAP_ID) throw fail("REPORT_NOT_FOUND", "no such report", 404);
      return reportDetail;
    },
    get_incoming_swap_utxo: () => null,
    verify_deniability: () => true,
    get_restore_logs: () => [],
    get_logs: () => [{ line: "2026-10-17T00:00:00Z INFO portal: e2e log line" }],

    // Routers
    list_makers: () => s.routers,
    list_dashboard_imports: () => [],
    get_router_defaults: () => routerDefaults,
    get_suggested_maker_ports: () => ({ networkPort: 6202, rpcPort: 6203 }),
    check_maker_ports: () => ({}),
    check_router_config: () => null,
    init_maker: (args) => {
      const config = args.config as RouterSettings;
      s.routers.push({ ...routerSettings(config.routerId), ...config });
      s.routerStatus[config.routerId] = {
        routerId: config.routerId,
        phase: { phase: "stopped" },
        running: false,
        networkPort: config.networkPort,
        walletEncrypted: true,
      };
      return s.routerStatus[config.routerId];
    },
    get_router_recovery_phrase: () => null,
    confirm_router_recovery_phrase_saved: () => null,
    update_maker_settings: (args) => args.settings,
    get_saved_maker_settings: (args) => router(args),
    clear_maker_settings: () => null,
    get_maker_status: (args) => {
      router(args);
      return s.routerStatus[String(args.routerId)];
    },
    start_maker: (args) => {
      const status = s.routerStatus[String(args.routerId)];
      Object.assign(status, { phase: { phase: "running" }, running: true });
      return null;
    },
    stop_maker: (args) => {
      const status = s.routerStatus[String(args.routerId)];
      Object.assign(status, { phase: { phase: "stopped" }, running: false });
      return null;
    },
    get_maker_info: (args) => ({
      walletName: router(args).walletName,
      walletPath: "wallet",
      dataDir: "/data",
    }),
    get_maker_balances: () => ({ regular: 400_000, swap: 0, contract: 0, fidelity: 50_000, spendable: 400_000 }),
    list_maker_addresses: () => addresses,
    list_maker_utxos: () => utxos,
    get_maker_transactions: () => s.transactions,
    get_maker_new_address: (args) => ({ address: ADDRESS, addressType: String(args.addressType) }),
    send_maker_to_address: () => ({ txid: TXID(98) }),
    sync_maker_wallet: () => null,
    list_maker_fidelity_bonds: () => [
      {
        outpoint: { txid: TXID(50), vout: 0 },
        amountSats: 50_000,
        lockTimeHeight: 251_000,
        isSpent: false,
        isLocked: true,
      },
    ],
    list_maker_swap_reports: () => [],
    get_maker_swap_report: () => {
      throw fail("REPORT_NOT_FOUND", "no such report", 404);
    },
    verify_maker_deniability: () => true,
    get_maker_logs: () => [{ line: "2026-10-17T00:00:00Z INFO router: listening" }],

    // Blocklists
    list_taker_blocklist: () => [],
    import_taker_blocklist: () => ({ added: 0, updated: 0, rejected: [] }),
    remove_taker_blocklist: () => 0,
    list_maker_blocklist: () => [],
    import_maker_blocklist: () => ({ added: 0, updated: 0, rejected: [] }),
    remove_maker_blocklist: () => 0,
  };
}

export interface CommandCall {
  name: string;
  args: Args;
}

/**
 * How a command's response reaches the page:
 * - `durable`: accepted with a 202, its record readable at `/operations/{key}`, as the real host
 *   answers money-moving commands. `pending` polls read `running` before the record settles.
 * - `lost-after-accept`: the work is done and journaled, but the connection drops before the
 *   response arrives.
 * - `lost-before-accept`: the connection drops and the server never saw the request.
 */
export type Delivery =
  | { kind: "durable"; pending?: number; settle?: OperationRecord["state"]; error?: AppError }
  | { kind: "lost-after-accept" }
  | { kind: "lost-before-accept" };

export class FakePortal {
  readonly state: FakeState = defaultState();
  readonly calls: CommandCall[] = [];
  /** Commands the UI called that the fake has no answer for. Checked after every test. */
  readonly unhandled: string[] = [];
  private readonly overrides: Record<string, Handler> = {};
  private readonly deliveries: Record<string, Delivery> = {};
  /** Durable records by idempotency key, with how many more reads stay `running`. */
  readonly journal = new Map<string, OperationRecord & { pending: number }>();
  /** Bodies the page posted to the non-command routes, by route. */
  readonly posted: { path: string; body: unknown }[] = [];
  private handlers = defaultHandlers(this.state);

  /** Replaces one command's answer for the rest of the test: a fixed value or a handler. */
  on(name: string, handler: Handler): void;
  on(name: string, value: unknown): void;
  on(name: string, handler: unknown) {
    this.overrides[name] =
      typeof handler === "function" ? (handler as Handler) : () => handler;
  }

  /** Changes how `name`'s responses are delivered, for the rest of the test. */
  deliver(name: string, delivery: Delivery) {
    this.deliveries[name] = delivery;
  }

  postedTo(path: string): unknown[] {
    return this.posted.filter((p) => p.path === path).map((p) => p.body);
  }

  /** Ends the running swap the way `start_swap` returning does: the slot empties. */
  finishSwap(phase: "completed" | "failed" = "completed") {
    if (!this.state.swap) throw new Error("no swap to finish");
    this.state.swap.running = false;
    this.state.swap.tracker.phase = phase;
    this.state.swap.tracker.routers.forEach((r) => (r.stage = "settled"));
  }

  callsTo(name: string): Args[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }

  handles(name: string): boolean {
    return name in this.handlers || name in this.overrides;
  }

  async install(page: Page) {
    await page.route("**/api/v1/**", (route) => this.dispatch(route));
  }

  private async dispatch(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/v1/, "");
    const method = request.method();
    const s = this.state;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const denied = (message: string, status = 401) =>
      json({ error: { code: "AUTHORIZATION_DENIED", message, details: { hasOwner: s.hasOwner } } }, status);

    if (path === "/session" && method === "GET") {
      return s.authenticated ? json({ hasOwner: s.hasOwner }) : denied("authentication required");
    }
    if (path === "/auth/claim") {
      if (s.hasOwner) return denied("this installation already has an owner", 403);
      s.hasOwner = true;
      return json({ status: "claimed" });
    }
    if (path === "/auth/login") {
      const { password } = request.postDataJSON() as { password: string };
      if (password !== OWNER_PASSWORD) return denied("login failed");
      s.authenticated = true;
      return json({ csrfToken: "e2e-csrf" });
    }
    if (path === "/auth/logout") {
      s.authenticated = false;
      return json(null);
    }
    if (!s.authenticated) return denied("authentication required");

    // One empty event stream: EventSource reconnects on its own, and no suite pushes events yet.
    if (path === "/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": e2e\n\n" });
    }
    if (path === "/operations" && method === "GET") {
      if (!s.journalReadable) return json({ error: { code: "INTERNAL", message: "journal unavailable" } }, 503);
      return json({ blockingConflicts: s.blocking });
    }
    const operation = /^\/operations\/([\w-]+)(?:\/(reconcile|acknowledge))?$/.exec(path);
    if (operation) {
      const [, id, action] = operation;
      if (action) {
        this.posted.push({ path: `/operations/${action}`, body: id });
        if (action === "acknowledge") s.blocking = s.blocking.filter((op) => op.operationId !== id);
        return json(null);
      }
      const record = this.journal.get(id);
      if (!record) return json({ error: { code: "INVALID_INPUT", message: "no operation with that id" } }, 404);
      if (record.pending > 0) {
        record.pending -= 1;
        return json({ operationId: id, state: "running" });
      }
      return json({ operationId: id, state: record.state, result: record.result, error: record.error });
    }

    // Uploads and backups: the web host's file routes, outside the command table.
    if (path === "/uploads") {
      this.posted.push({ path, body: request.postData() });
      return json({ selectionId: "upload-1", displayName: "portal-wallet-backup.json" });
    }
    if (path === "/backups") {
      this.posted.push({ path, body: request.postDataJSON() });
      return json({ artifactId: "backup-1" });
    }
    if (path === "/backups/backup-1/download") {
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"e2e":"backup"}' });
    }

    const command = /^\/commands\/(\w+)$/.exec(path)?.[1];
    if (!command) return json({ error: { code: "INTERNAL", message: `fake has no ${path}` } }, 404);

    const args = (request.postDataJSON() ?? {}) as Args;
    const key = request.headers()["idempotency-key"];
    const delivery: Delivery | undefined =
      this.deliveries[command] ?? (DURABLE.has(command) ? { kind: "durable" } : undefined);
    if (delivery?.kind === "lost-before-accept") return route.abort("connectionreset");
    this.calls.push({ name: command, args });

    const handler = this.overrides[command] ?? this.handlers[command];
    if (!handler) {
      this.unhandled.push(command);
      return json({ error: { code: "INTERNAL", message: `fake has no ${command}` } }, 500);
    }
    let outcome: { result: unknown } | { error: FakeError };
    try {
      outcome = { result: (await handler(args)) ?? null };
    } catch (e) {
      if (!(e instanceof FakeError)) throw e;
      outcome = { error: e };
    }

    if (delivery) {
      const settled = delivery.kind === "durable" ? delivery.settle : undefined;
      this.journal.set(key, {
        pending: delivery.kind === "durable" ? (delivery.pending ?? 0) : 0,
        state: settled ?? ("result" in outcome ? "succeeded" : "failed"),
        result: "result" in outcome ? outcome.result : undefined,
        error: delivery.kind === "durable" && delivery.error ? delivery.error : "error" in outcome ? outcome.error.error : undefined,
      });
      if (delivery.kind === "lost-after-accept") return route.abort("connectionreset");
      return json({ operationId: key }, 202);
    }
    if ("error" in outcome) return json({ error: outcome.error.error }, outcome.error.status);
    return json(outcome.result);
  }
}
