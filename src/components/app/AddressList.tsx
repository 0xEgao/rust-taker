import { Download } from "lucide-react";
import type { WalletAddress } from "../../api/types";
import { Identifier, SatsAmount } from "../ui/display";

/** A wallet's addresses, as the wallet's Receive card and a router's Wallet tab show them.
 *  `null` while loading. */
export function AddressList({ addresses, csvName }: { addresses: WalletAddress[] | null; csvName: string }) {
  function exportCsv() {
    const rows = [
      "address,type,keychain,derivation_path,balance_sats,unconfirmed",
      ...(addresses ?? []).map(
        (a) =>
          `${a.address},${a.addressType},${a.change ? "change" : "receive"},${a.derivationPath},${a.balanceSats},${a.unconfirmed}`,
      ),
    ];
    const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = csvName;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="flex flex-col divide-y divide-line">
        {addresses === null && <p className="py-2 text-[11.5px] text-subtle">Loading…</p>}
        {addresses?.length === 0 && <p className="py-2 text-[11.5px] text-subtle">No addresses yet.</p>}
        {addresses?.map((a) => (
          <div key={a.address} className="flex items-center justify-between gap-3 py-2 text-[11.5px]">
            <span className="min-w-0">
              <Identifier value={a.address} className="block text-[11.5px] leading-[1.45] text-muted" />
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-subtle">
                <span>{a.derivationPath}</span>
                <span>{a.addressType === "p2tr" ? "Taproot" : "SegWit"}</span>
                {a.change && <span>Change</span>}
                {a.unconfirmed && <span className="text-warning">Unconfirmed</span>}
              </span>
            </span>
            <SatsAmount
              sats={a.balanceSats}
              className={`flex-none font-semibold ${a.balanceSats > 0 ? "text-success" : "text-subtle"}`}
            />
          </div>
        ))}
      </div>
      {addresses && addresses.length > 0 && (
        <button
          type="button"
          onClick={exportCsv}
          className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-primary hover:text-primary-hover"
        >
          <Download size={12} strokeWidth={2} /> Export CSV
        </button>
      )}
    </>
  );
}
