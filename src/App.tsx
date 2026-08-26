import { useEffect } from "react";
import { HashRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/app/AppShell";
import { LaunchPage } from "./pages/launch/LaunchPage";
import { LogsPage } from "./pages/logs/LogsPage";
import { MakerPage } from "./pages/maker/MakerPage";
import { AddMakerPage } from "./pages/maker/AddMakerPage";
import { MakerWorkspacePage } from "./pages/maker/MakerWorkspacePage";
import { MakerSetupPage } from "./pages/maker/MakerSetupPage";
import { MakerSwapReportPage } from "./pages/maker/MakerSwapReportPage";
import { MarketPage } from "./pages/market/MarketPage";
import { SendPage } from "./pages/send/SendPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { SetupPage } from "./pages/setup/SetupPage";
import { SwapPage } from "./pages/swap/SwapPage";
import { SwapReportPage } from "./pages/swap/SwapReportPage";
import { SwapReportsPage } from "./pages/swap/SwapReportsPage";
import { WalletPage } from "./pages/wallet/WalletPage";
import { refreshWalletCache } from "./lib/wallet-sync";
import { useSessionStore } from "./store/session";
import { REFRESH_INTERVAL_MS } from "./store/wallet-cache";

/**
 * Guards the taker half only. Maker routes are deliberately outside it: maker commands
 * resolve their wallet and data dir from the maker's own registration, so a maker session
 * needs no taker. The taker session is per-launch memory state, so every launch starts at
 * the role picker no matter what exists on disk.
 */
function RequireTaker() {
  const initialized = useSessionStore((s) => s.initialized);

  // Scoped here rather than in AppShell because this is the only subtree where a taker is
  // guaranteed to exist — a maker-only session would otherwise sync a wallet that isn't
  // there. Runs regardless of the active taker route so Send/Swap never depend on the
  // Wallet page having been mounted recently.
  useEffect(() => {
    if (!initialized) return;
    const id = setInterval(() => void refreshWalletCache(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [initialized]);

  if (!initialized) return <Navigate to="/launch" replace />;
  return <Outlet />;
}

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/launch" element={<LaunchPage />} />
        <Route path="/setup" element={<SetupPage />} />

        <Route element={<AppShell />}>
          <Route element={<RequireTaker />}>
            <Route path="/" element={<WalletPage />} />
            <Route path="/market" element={<MarketPage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/swap" element={<SwapPage />} />
            <Route path="/swap/reports" element={<SwapReportsPage />} />
            <Route path="/swap/reports/:swapId" element={<SwapReportPage />} />
            <Route path="/logs" element={<LogsPage />} />
          </Route>

          <Route path="/maker" element={<MakerPage />} />
          <Route path="/maker/new" element={<AddMakerPage />} />
          <Route path="/maker/:makerId" element={<MakerWorkspacePage />} />
          <Route path="/maker/:makerId/setup" element={<MakerSetupPage />} />
          <Route path="/maker/:makerId/report/:swapId" element={<MakerSwapReportPage />} />

          {/* Chain-backend and Tor config are global, so the page renders its taker-only
              sections conditionally rather than assuming an unlocked wallet. */}
          <Route path="/settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/launch" replace />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
