import { useNavigate } from "react-router-dom";
import type { InitResult } from "../../api/types";
import { OnboardingShell } from "../../components/onboarding/OnboardingShell";
import { Button } from "../../components/ui/inputs";
import { startWalletSynchronization } from "../../lib/wallet-sync";
import { useBootstrapStore } from "../../onboarding/store";
import { useSessionStore } from "../../store/session";
import { useWalletCacheStore } from "../../store/wallet-cache";
import { SelectWalletStep } from "./SelectWalletStep";

export function SetupPage() {
  const navigate = useNavigate();
  const setInitialized = useSessionStore((s) => s.setInitialized);
  const beginWalletSession = useWalletCacheStore((s) => s.beginSession);
  const noteResourceAdded = useBootstrapStore((s) => s.noteResourceAdded);
  const setLastRole = useBootstrapStore((s) => s.setLastRole);
  const makerCount = useBootstrapStore((s) => s.makerCount) ?? 0;

  function completeSetup(result: InitResult, restored: boolean) {
    beginWalletSession(result.walletName, result.dataDir, restored);
    setInitialized(result);
    setLastRole("taker");
    noteResourceAdded("taker");
    void startWalletSynchronization();
    // The router is always mounted now, so reaching the app is an explicit navigation
    // rather than a re-render of the session gate.
    navigate("/", { replace: true });
  }

  return (
    <OnboardingShell title="Coinswap · Taker" status="Onboarding">
      <SelectWalletStep onSuccess={completeSetup} />
      <div className="flex flex-wrap items-center justify-center gap-2 border-t border-line px-8 py-4">
        <Button variant="secondary" size="sm" onClick={() => navigate("/onboarding")}>
          Back to roles
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate(makerCount > 0 ? "/maker" : "/onboarding/maker")}
        >
          {makerCount > 0 ? "Go to my makers" : "Set up a maker instead"}
        </Button>
      </div>
    </OnboardingShell>
  );
}
