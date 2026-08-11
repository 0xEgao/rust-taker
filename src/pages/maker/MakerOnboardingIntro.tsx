import { Clock, Coins, Lock, Power, Server, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { Card } from "../../components/ui/display";

const PREREQUISITES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ShieldCheck,
    title: "Tor must be reachable",
    body: "Makers are only addressable as an onion service. Your SOCKS and control ports are checked before the maker starts.",
  },
  {
    icon: Lock,
    title: "Fidelity collateral, time-locked",
    body: "A bond proves you have skin in the game so takers will trust you. Those funds are locked until the timelock height passes — you cannot spend them early.",
  },
  {
    icon: Coins,
    title: "Swap liquidity, on top of the bond",
    body: "Separate spendable balance is what people actually swap against. A funded bond alone is not enough to go live.",
  },
  {
    icon: Clock,
    title: "Setup waits for confirmation",
    body: "The bond transaction has to confirm on-chain before your maker is announced, so expect to wait for at least one block.",
  },
  {
    icon: Power,
    title: "Makers never auto-start",
    body: "Closing the app stops every maker. You start them explicitly, and swaps are only served while one is running.",
  },
];

/**
 * Shown instead of the dashboard when no makers are registered. The metric row and status
 * filters are deliberately absent here: reporting zeros across a full dashboard reads as
 * "something is broken" rather than "nothing exists yet".
 */
export function MakerOnboardingIntro() {
  return (
    <div className="mx-auto w-full max-w-[900px] py-4">
      <div className="text-center">
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-card border border-primary/35 bg-primary/10 text-primary">
          <Server size={26} strokeWidth={1.7} />
        </span>
        <h1 className="mt-5 font-header text-[27px] font-bold leading-tight text-foreground">
          Earn fees by providing liquidity
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[13.5px] leading-relaxed text-muted">
          A maker keeps funds available for other people to swap against and charges a fee for it.
          Setup is a guided sequence — configure, fund a fidelity bond, wait for it to confirm, then
          fund swap liquidity. Here is what it asks of you first.
        </p>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        {PREREQUISITES.map(({ icon: Icon, title, body }) => (
          // Odd count, so the trailing card spans the row instead of leaving a hole beside it.
          <Card key={title} className="flex gap-3.5 border-line-strong p-5 last:col-span-2 max-[760px]:last:col-span-1">
            <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-control border border-line bg-surface text-warning">
              <Icon size={15} strokeWidth={1.9} />
            </span>
            <span>
              <strong className="block text-[13px] font-semibold text-foreground">{title}</strong>
              <span className="mt-1 block text-[12px] leading-relaxed text-muted">{body}</span>
            </span>
          </Card>
        ))}
      </div>

      <div className="mt-8 flex flex-col items-center gap-3">
        <Link
          to="/maker/new"
          className="inline-flex h-11 items-center gap-2 rounded-control bg-primary px-6 text-[13.5px] font-semibold text-white transition-colors hover:bg-primary-hover"
        >
          <Server size={16} strokeWidth={1.9} />
          Create your first maker
        </Link>
        <p className="text-[11.5px] text-subtle">
          Nothing is broadcast until you fund the bond. You can stop and resume setup at any point.
        </p>
      </div>
    </div>
  );
}
