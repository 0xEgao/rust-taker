import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/app/AppShell";
import { LogsPage } from "./pages/logs/LogsPage";
import { MarketPage } from "./pages/market/MarketPage";
import { SendPage } from "./pages/send/SendPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { SetupPage } from "./pages/setup/SetupPage";
import { SwapPage } from "./pages/swap/SwapPage";
import { SwapReportPage } from "./pages/swap/SwapReportPage";
import { SwapReportsPage } from "./pages/swap/SwapReportsPage";
import { WalletPage } from "./pages/wallet/WalletPage";
import { useSessionStore } from "./store/session";

function App() {
  const initialized = useSessionStore((s) => s.initialized);

  if (!initialized) {
    return <SetupPage />;
  }

  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<WalletPage />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/send" element={<SendPage />} />
          <Route path="/swap" element={<SwapPage />} />
          <Route path="/swap/reports" element={<SwapReportsPage />} />
          <Route path="/swap/reports/:swapId" element={<SwapReportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

export default App;
