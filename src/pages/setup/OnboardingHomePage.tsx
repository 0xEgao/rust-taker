import { Server, Wallet } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { OnboardingShell } from "../../components/onboarding/OnboardingShell";
import { RoleCard } from "../../components/onboarding/RoleCard";
import { Button } from "../../components/ui/inputs";
import { Headline } from "../../components/ui/layout";
import { useBootstrapStore } from "../../onboarding/store";

export function OnboardingHomePage() {
  const navigate = useNavigate();
  const walletCount = useBootstrapStore((s) => s.walletCount) ?? 0;
  const makerCount = useBootstrapStore((s) => s.makerCount) ?? 0;
  const setLastRole = useBootstrapStore((s) => s.setLastRole);
  const markSeen = useBootstrapStore((s) => s.markSeen);

  function choose(role: "taker" | "maker") {
    setLastRole(role);
    markSeen();
    navigate(role === "taker" ? "/onboarding/taker" : "/onboarding/maker");
  }

  const hasExisting = walletCount > 0 || makerCount > 0;

  return (
    <OnboardingShell title="Coinswap" status="Welcome" wide>
      <div className="p-8">
        <div className="text-center">
          <Headline text="Private bitcoin" accent="swaps." />
          <p className="mx-auto mt-3 max-w-xl text-[13.5px] leading-relaxed text-muted">
            Coinswap breaks the on-chain link between your coins and their history by swapping them
            with other participants over Tor. Pick a role to begin — you can add the other later,
            and neither one requires the other.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-2 items-start gap-4 max-[720px]:grid-cols-1">
          <RoleCard
            icon={Wallet}
            kicker="Use Coinswap privately"
            title="Set up a Taker"
            summary="Create or unlock a wallet, discover makers over Tor, and initiate swaps yourself. Takes about 2–3 minutes."
            commitments={[
              "Tor must be running — every swap and chain query is routed through it.",
              "Your wallet is encrypted; losing the password means losing access to the coins.",
              "You need funds in the wallet before a swap can be started.",
            ]}
            actionLabel="Set up a Taker"
            onSelect={() => choose("taker")}
          />
          <RoleCard
            icon={Server}
            kicker="Provide liquidity"
            title="Set up a Maker"
            summary="Run an online service that other people swap against, and earn fees on the liquidity you provide."
            commitments={[
              "A fidelity bond locks collateral for a fixed number of blocks — you cannot spend it until the timelock expires.",
              "Your wallet needs bond collateral and separate spendable swap liquidity.",
              "The maker must stay running to serve swaps, and never auto-starts when the app opens.",
              "Setup waits for an on-chain confirmation, so it is not instant.",
            ]}
            actionLabel="Set up a Maker"
            onSelect={() => choose("maker")}
          />
        </div>

        {hasExisting && (
          <div className="mt-7 border-t border-line pt-5 text-center">
            <p className="text-[12px] text-subtle">
              {walletCount > 0 && `${walletCount} wallet${walletCount === 1 ? "" : "s"} found`}
              {walletCount > 0 && makerCount > 0 && " · "}
              {makerCount > 0 && `${makerCount} maker${makerCount === 1 ? "" : "s"} registered`}
            </p>
            <div className="mt-3 flex justify-center gap-2">
              {walletCount > 0 && (
                <Button variant="secondary" size="sm" onClick={() => choose("taker")}>
                  Unlock existing wallet
                </Button>
              )}
              {makerCount > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setLastRole("maker");
                    markSeen();
                    navigate("/maker");
                  }}
                >
                  Go to my makers
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </OnboardingShell>
  );
}
