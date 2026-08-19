import { HashRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/app/AppShell";
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
import { useSessionStore } from "./store/session";

/**
 * An unlocked taker wallet is the only way into the app, maker routes included — the maker
 * commands read the same session, and the taker session is per-launch memory state, so every
 * launch starts at setup no matter what exists on disk.
 */
function RequireTaker() {
  const initialized = useSessionStore((s) => s.initialized);
  if (!initialized) return <Navigate to="/setup" replace />;
  return <Outlet />;
}

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />

        <Route element={<RequireTaker />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<WalletPage />} />
            <Route path="/market" element={<MarketPage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/swap" element={<SwapPage />} />
            <Route path="/swap/reports" element={<SwapReportsPage />} />
            <Route path="/swap/reports/:swapId" element={<SwapReportPage />} />

            <Route path="/maker" element={<MakerPage />} />
            <Route path="/maker/new" element={<AddMakerPage />} />
            <Route path="/maker/:makerId" element={<MakerWorkspacePage />} />
            <Route path="/maker/:makerId/setup" element={<MakerSetupPage />} />
            <Route path="/maker/:makerId/report/:swapId" element={<MakerSwapReportPage />} />

            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/logs" element={<LogsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
