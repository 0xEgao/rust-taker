import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { quitApp } from "../../api/commands";
import type { QuitBlockers } from "../../api/types";
import { Button } from "../ui/inputs";
import { Modal } from "../ui/display";

/**
 * Teardown is unbounded — a maker closes by finishing its connections and a full wallet sync.
 * Both states exist so that wait reads as work rather than as a hung window.
 */
export function QuitShutdown() {
  const [blockers, setBlockers] = useState<QuitBlockers | null>(null);
  const [step, setStep] = useState<string | null>(null);

  useEffect(() => {
    const unlisteners = [
      listen<QuitBlockers>("app://quit-blocked", (e) => setBlockers(e.payload)),
      listen("app://quitting", () => {
        setBlockers(null);
        setStep("Shutting down");
      }),
      listen<string>("app://quit-progress", (e) => setStep(e.payload)),
    ];
    return () => {
      void Promise.all(unlisteners).then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  if (step !== null) {
    return (
      <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-surface">
        <p className="font-header text-[15px] font-bold text-foreground">{step}…</p>
        <p className="max-w-sm text-center text-[12px] leading-5 text-muted">
          Letting the maker and taker finish and close their wallets. Quitting before they
          are done is what leaves state to repair on the next launch.
        </p>
      </div>
    );
  }

  if (!blockers) return null;

  const running = [
    blockers.swapRunning ? "a coinswap" : null,
    blockers.runningMakers.length === 1
      ? `the maker ${blockers.runningMakers[0]}`
      : blockers.runningMakers.length > 1
        ? `${blockers.runningMakers.length} makers`
        : null,
  ].filter(Boolean);

  return (
    <Modal
      title="Something is still running"
      onClose={() => setBlockers(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => setBlockers(null)}>
            Keep running
          </Button>
          <Button onClick={() => void quitApp()}>
            Quit anyway
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] leading-5 text-muted">
        Quitting now stops {running.join(" and ")}.
      </p>
      {blockers.swapRunning && (
        <p className="text-[12.5px] leading-5 text-muted">
          The swap is recorded at its last completed phase, so the next launch picks it up
          for recovery — but it cannot be resumed where it left off, and the funds stay in
          their timelocked contracts until recovery clears them.
        </p>
      )}
      {blockers.runningMakers.length > 0 && (
        <p className="text-[12.5px] leading-5 text-muted">
          Makers finish serving their current connections before stopping, so this can take
          a moment.
        </p>
      )}
    </Modal>
  );
}
