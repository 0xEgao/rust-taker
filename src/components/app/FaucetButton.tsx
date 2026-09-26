import { Droplets, ExternalLink } from "lucide-react";
import { openExternal } from "../../platform";
import { FAUCET_URL, isOurSignet, useConnectionStore } from "../../store/connection";

/** Coins on our signet have no value and nowhere to be bought, so the faucet is the only way
 *  to get any — which is also why it renders on no other chain: where coins are real, a "free
 *  coins" button is at best a lie. */
export function FaucetButton() {
  const ours = useConnectionStore(isOurSignet);
  if (!ours) return null;
  return (
    <button
      type="button"
      onClick={() => void openExternal(FAUCET_URL)}
      title="Get signet coins from our faucet"
      className="lift inline-flex flex-none items-center gap-1.5 rounded-pill border border-primary/30 bg-primary/[0.08] px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-primary outline-none hover:border-primary/50 hover:bg-primary/[0.14] focus-visible:shadow-ring"
    >
      <Droplets size={12} strokeWidth={2} />
      Faucet
      <ExternalLink size={11} strokeWidth={2} />
    </button>
  );
}
