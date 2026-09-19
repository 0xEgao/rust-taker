import { LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { lockWallet } from "../../api/commands";
import { IconButton } from "../ui/display";
import { useSessionStore } from "../../store/session";
import { useUnresolvedStore } from "../../store/unresolved";
import { useToastStore } from "../../store/toast";
import { useWalletCacheStore } from "../../store/wallet-cache";

/**
 * Releases the wallet and returns to the role picker, so a different one can be unlocked
 * without restarting Portal.
 *
 * Not a sign-out: on the web the session and the server stay up, and any router keeps running.
 * The backend refuses while a swap is holding the wallet, which surfaces as a warning rather
 * than being pre-empted here — whether a swap is running is not something this header knows.
 */
export function SwitchWallet() {
  const reset = useSessionStore((s) => s.reset);
  const resetCache = useWalletCacheStore((s) => s.reset);
  const resetUnresolved = useUnresolvedStore((s) => s.reset);
  const pushFailure = useToastStore((s) => s.pushFailure);
  const navigate = useNavigate();
  const [working, setWorking] = useState(false);

  async function switchWallet() {
    if (working) return;
    setWorking(true);
    try {
      await lockWallet();
      // Only after the backend has actually let go: clearing first would leave the UI
      // claiming no wallet while the process still held one.
      resetCache();
      resetUnresolved();
      reset();
      navigate("/launch", { replace: true });
    } catch (e) {
      pushFailure(e, "Could not close the wallet.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <IconButton
      onClick={() => void switchWallet()}
      disabled={working}
      label="Close wallet"
      icon={<LogOut size={16} strokeWidth={1.8} />}
    />
  );
}
