import { getLogs } from "../../api/commands";
import { LogPanel } from "../../components/app/LogPanel";
import { BackButton } from "../../components/ui/display";

export function LogsPage() {
  return (
    <div className="flex h-full flex-col overflow-hidden px-8 pb-8 pt-2">
      <div className="flex shrink-0 items-center gap-3 pb-4">
        <BackButton to="/" label="Back to Wallet" />
        <div>
          <h1 className="font-header text-[26px] font-bold text-foreground">Logs</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            This wallet's active debug.log. Older entries rotate out as it grows.
          </p>
        </div>
      </div>
      <LogPanel title="Wallet logs" load={getLogs} className="flex-1" />
    </div>
  );
}
