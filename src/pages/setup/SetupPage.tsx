import { Background, Shell } from "../../components/ui/layout";
import type { InitResult } from "../../api/types";
import { useSessionStore } from "../../store/session";
import { useWalletCacheStore } from "../../store/wallet-cache";
import { startWalletSynchronization } from "../../lib/wallet-sync";
import { SelectWalletStep } from "./SelectWalletStep";

export function SetupPage() {
  const setInitialized = useSessionStore((s) => s.setInitialized);
  const beginWalletSession = useWalletCacheStore((s) => s.beginSession);

  function completeSetup(result: InitResult, restored: boolean) {
    beginWalletSession(result.walletName, result.dataDir, restored);
    setInitialized(result);
    void startWalletSynchronization();
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6 py-10">
      <Background />
      <div className="relative w-full max-w-2xl">
        <Shell title="Coinswap · Taker" status="Onboarding">
          <SelectWalletStep onSuccess={completeSetup} />
        </Shell>
      </div>
    </div>
  );
}
