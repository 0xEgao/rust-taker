import { checkPort, getBalances, getTransactions, getWalletInfo, listUtxos, syncWallet } from "../api/commands";
import { useWalletCacheStore } from "../store/wallet-cache";
import { ELECTRUM_HOST, ELECTRUM_PORT } from "./connectivity";

let hydrateInFlight: Promise<void> | null = null;
let refreshInFlight: Promise<void> | null = null;

/** Read the encrypted wallet file's persisted UTXO snapshot; no network I/O. */
export function hydrateWalletCache(): Promise<void> {
  if (hydrateInFlight) return hydrateInFlight;
  hydrateInFlight = Promise.all([getWalletInfo(), getBalances(), listUtxos()])
    .then(([info, balances, utxos]) => {
      useWalletCacheStore.getState().setStoredData({ info, balances, utxos });
    })
    .finally(() => {
      hydrateInFlight = null;
    });
  return hydrateInFlight;
}

/** Run one coalesced Electrum sync, then refresh the visible wallet snapshot. */
export function refreshWalletCache(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const cache = useWalletCacheStore.getState();
    cache.setSyncing();
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Avoid entering coinswap's retry-forever sync while the endpoint is
      // already known to be unreachable.
      const reachability = await checkPort(ELECTRUM_HOST, ELECTRUM_PORT, 3000);
      if (!reachability.reachable) {
        throw new Error(reachability.error ?? "Electrum server is unreachable.");
      }

      slowTimer = setTimeout(() => {
        if (useWalletCacheStore.getState().syncStatus === "syncing") {
          useWalletCacheStore
            .getState()
            .setSyncError("Wallet sync is taking longer than expected. Spending remains disabled.");
        }
      }, 15_000);

      await syncWallet();
      clearTimeout(slowTimer);
      cache.setSyncSuccess();

      await hydrateWalletCache();
      const transactions = await getTransactions(50, 0).catch(() => useWalletCacheStore.getState().transactions);
      const current = useWalletCacheStore.getState();
      if (current.info && current.balances) {
        current.setData({ info: current.info, balances: current.balances, utxos: current.utxos, transactions });
      }
    } catch (error) {
      if (slowTimer) clearTimeout(slowTimer);
      cache.setSyncError((error as { message?: string })?.message ?? "Wallet synchronization failed.");
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/** Always hydrate before starting network work so persisted data can paint first. */
export async function startWalletSynchronization(): Promise<void> {
  await hydrateWalletCache().catch(() => {});
  await refreshWalletCache();
}
