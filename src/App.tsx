import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { AppShell } from "./components/app/AppShell";
import { LogsPage } from "./pages/logs/LogsPage";
import { MakerPage } from "./pages/maker/MakerPage";
import { AddMakerPage } from "./pages/maker/AddMakerPage";
import { MakerOnboardingIntro } from "./pages/maker/MakerOnboardingIntro";
import { MakerWorkspacePage } from "./pages/maker/MakerWorkspacePage";
import { MakerSwapReportPage } from "./pages/maker/MakerSwapReportPage";
import { MarketPage } from "./pages/market/MarketPage";
import { SendPage } from "./pages/send/SendPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { OnboardingHomePage } from "./pages/setup/OnboardingHomePage";
import { SetupPage } from "./pages/setup/SetupPage";
import { SwapPage } from "./pages/swap/SwapPage";
import { SwapReportPage } from "./pages/swap/SwapReportPage";
import { SwapReportsPage } from "./pages/swap/SwapReportsPage";
import { WalletPage } from "./pages/wallet/WalletPage";
import { useBootstrapStore } from "./onboarding/store";
import { useSessionStore } from "./store/session";

/**
 * Taker-only routes need an unlocked `Taker` in the backend. Maker routes deliberately do not:
 * maker registrations and runtimes are independent of the taker session, so someone who only
 * operates makers must never be forced to create a taker wallet.
 */
function RequireTaker({ children }: { children: ReactNode }) {
  const initialized = useSessionStore((s) => s.initialized);
  // Defers to BootstrapRedirect rather than hardcoding a target, so "where does an
  // uninitialized user belong" is decided in exactly one place — including for `/`, which
  // matches this route and would otherwise never reach the catch-all.
  if (!initialized) return <BootstrapRedirect />;
  return <>{children}</>;
}

/** Decides the landing route once, from resources on disk rather than a stored "done" flag. */
function BootstrapRedirect() {
  const initialized = useSessionStore((s) => s.initialized);
  const walletCount = useBootstrapStore((s) => s.walletCount);
  const makerCount = useBootstrapStore((s) => s.makerCount);
  const seenVersion = useBootstrapStore((s) => s.seenVersion);
  const lastRole = useBootstrapStore((s) => s.lastRole);

  if (initialized) return <Navigate to="/" replace />;
  // Counts are null until the listing settles; rendering the welcome early would flash it at
  // returning users who actually have wallets.
  if (walletCount === null || makerCount === null) {
    return <div className="min-h-screen bg-bg" />;
  }

  const nothingExists = walletCount === 0 && makerCount === 0;
  if (nothingExists || seenVersion === 0) return <Navigate to="/onboarding" replace />;
  if (walletCount === 0 && makerCount > 0) return <Navigate to="/maker" replace />;
  if (lastRole === "maker" && makerCount > 0) return <Navigate to="/maker" replace />;
  return <Navigate to="/onboarding/taker" replace />;
}

function App() {
  const resolve = useBootstrapStore((s) => s.resolve);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  return (
    <HashRouter>
      <Routes>
        <Route path="/onboarding" element={<OnboardingHomePage />} />
        <Route path="/onboarding/taker" element={<SetupPage />} />

        <Route element={<AppShell />}>
          <Route path="/" element={<RequireTaker><WalletPage /></RequireTaker>} />
          <Route path="/market" element={<RequireTaker><MarketPage /></RequireTaker>} />
          <Route path="/send" element={<RequireTaker><SendPage /></RequireTaker>} />
          <Route path="/swap" element={<RequireTaker><SwapPage /></RequireTaker>} />
          <Route path="/swap/reports" element={<RequireTaker><SwapReportsPage /></RequireTaker>} />
          <Route path="/swap/reports/:swapId" element={<RequireTaker><SwapReportPage /></RequireTaker>} />

          {/* Maker routes are intentionally unguarded — see RequireTaker. */}
          <Route path="/onboarding/maker" element={<div className="h-full overflow-y-auto p-8"><MakerOnboardingIntro /></div>} />
          <Route path="/maker" element={<MakerPage />} />
          <Route path="/maker/new" element={<AddMakerPage />} />
          <Route path="/maker/:makerId" element={<MakerWorkspacePage />} />
          <Route path="/maker/:makerId/report/:swapId" element={<MakerSwapReportPage />} />

          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/logs" element={<LogsPage />} />
        </Route>

        <Route path="*" element={<BootstrapRedirect />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
