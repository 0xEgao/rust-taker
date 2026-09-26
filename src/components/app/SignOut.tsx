import { LogOut } from "lucide-react";
import { useState } from "react";
import { lockWallet } from "../../api/commands";
import { useToastStore } from "../../store/toast";
import { IconButton } from "../ui/display";

/**
 * Takes this window off its wallet and back to the connection gate. The app sign-in stays; the
 * wallet closes unless another browser is on it or a swap is running; routers keep running.
 *
 * Reloads rather than resetting stores one by one: every store, the passed gate included, is
 * this tab's view of a wallet session that no longer exists.
 */
export function SignOut() {
  const [busy, setBusy] = useState(false);

  async function exit() {
    if (busy) return;
    setBusy(true);
    try {
      await lockWallet();
    } catch (e) {
      // Still on the wallet in Rust, so leaving the page would only strand the session on it.
      useToastStore.getState().pushFailure(e, "Could not close the wallet.");
      setBusy(false);
      return;
    }
    window.location.hash = "#/connect";
    window.location.reload();
  }

  return (
    <IconButton
      onClick={() => void exit()}
      disabled={busy}
      label="Sign out"
      tooltipAlign="right"
      icon={<LogOut size={16} strokeWidth={1.8} />}
    />
  );
}
