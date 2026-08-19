import { ArrowDownLeft, ArrowUpRight, ChevronDown, Copy, Download, RefreshCw } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import { estimateFees, getBalances, getBtcPrice, getNewAddress, getTransactions, listUtxos, sendToAddress, validateAddress } from "../../api/commands";
import { isAppError } from "../../api/types";
import type { AddressType, Balances, FeeEstimate, NewAddress, Outpoint, TxSummary, UtxoEntry } from "../../api/types";
import { Card, Modal, SatsAmount } from "../../components/ui/display";
import { Button, PresetTile, SegmentedToggle, TextField } from "../../components/ui/inputs";
import {
  classifySpendType,
  formatFeeRate,
  formatUnitAmount,
  satsToUnitString,
  truncateMiddle,
  unitStringToSats,
  type Unit,
} from "../../lib/wallet-format";
import { useToastStore } from "../../store/toast";
import { useWalletCacheStore } from "../../store/wallet-cache";

type FeeKey = "low" | "mid" | "high" | "custom";

function SendPanel() {
  const pushToast = useToastStore((s) => s.push);
  const walletSyncStatus = useWalletCacheStore((s) => s.syncStatus);
  const walletSyncError = useWalletCacheStore((s) => s.syncError);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [utxos, setUtxos] = useState<UtxoEntry[]>([]);
  const [fees, setFees] = useState<FeeEstimate | null>(null);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);

  const [recipient, setRecipient] = useState("");
  const [recipientValidation, setRecipientValidation] = useState<"idle" | "checking" | "valid" | "invalid">("idle");
  const [recipientError, setRecipientError] = useState<string | undefined>();
  const [unit, setUnit] = useState<Unit>("sats");
  const [amountInput, setAmountInput] = useState("");
  const [feeKey, setFeeKey] = useState<FeeKey>("mid");
  const [customFeeRate, setCustomFeeRate] = useState("");
  const [selectedOutpoints, setSelectedOutpoints] = useState<Outpoint[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const [nextBalances, nextUtxos, nextFees] = await Promise.all([getBalances(), listUtxos(), estimateFees()]);
    setBalances(nextBalances);
    setUtxos(nextUtxos);
    setFees(nextFees);
  }, []);

  useEffect(() => {
    void load().catch((e) => pushToast("error", (e as { message?: string })?.message ?? "Failed to load wallet data."));
    // BTC/USD price is best-effort — sats/BTC still work fine without it, so its own failure
    // shouldn't toast an error, just leave the USD option disabled.
    void getBtcPrice()
      .then((p) => setBtcPrice(p.usd))
      .catch(() => setBtcPrice(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeUnit(nextUnit: Unit) {
    const sats = unitStringToSats(amountInput, unit, btcPrice);
    setAmountInput(satsToUnitString(sats, nextUnit, btcPrice));
    setUnit(nextUnit);
  }

  const amountSats = useMemo(
    () => unitStringToSats(amountInput, unit, btcPrice),
    [amountInput, unit, btcPrice],
  );
  const otherUnits = useMemo(() => (["sats", "btc", "usd"] as Unit[]).filter((u) => u !== unit), [unit]);

  const feeRate = useMemo(() => {
    if (feeKey === "custom") return Number(customFeeRate) || 0;
    if (!fees) return 0;
    return fees[feeKey];
  }, [feeKey, customFeeRate, fees]);

  const spendableUtxos = useMemo(() => utxos.filter((u) => u.spendable && u.solvable), [utxos]);
  const selectedTotal = useMemo(() => {
    const set = new Set(selectedOutpoints.map((o) => `${o.txid}:${o.vout}`));
    return spendableUtxos.filter((u) => set.has(`${u.txid}:${u.vout}`)).reduce((sum, u) => sum + u.amountSats, 0);
  }, [selectedOutpoints, spendableUtxos]);

  function toggleOutpoint(u: UtxoEntry) {
    const key = `${u.txid}:${u.vout}`;
    setSelectedOutpoints((prev) => {
      const exists = prev.some((o) => `${o.txid}:${o.vout}` === key);
      if (exists) return prev.filter((o) => `${o.txid}:${o.vout}` !== key);
      return [...prev, { txid: u.txid, vout: u.vout }];
    });
  }

  const amountError = amountInput.length > 0 && amountSats <= 0 ? "Enter a valid amount." : undefined;

  useEffect(() => {
    let cancelled = false;
    const address = recipient.trim();
    setRecipientError(undefined);
    if (!address) {
      setRecipientValidation("idle");
      return () => { cancelled = true; };
    }

    setRecipientValidation("checking");
    const timer = setTimeout(() => {
      void validateAddress(address)
        .then((result) => {
          if (cancelled) return;
          setRecipientValidation(result.valid ? "valid" : "invalid");
          setRecipientError(result.error);
        })
        .catch(() => {
          if (cancelled) return;
          setRecipientValidation("invalid");
          setRecipientError("Could not validate this address.");
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [recipient]);

  const walletReadyToSpend = walletSyncStatus === "synced";
  const canReview = walletReadyToSpend && recipientValidation === "valid" && amountSats > 0 && feeRate > 0;

  async function confirmSend() {
    if (useWalletCacheStore.getState().syncStatus !== "synced") {
      pushToast("error", "Wait for wallet synchronization before sending.");
      return;
    }
    setSending(true);
    try {
      const result = await sendToAddress(
        recipient.trim(),
        amountSats,
        feeRate,
        selectedOutpoints.length > 0 ? selectedOutpoints : undefined,
      );
      pushToast("success", `Broadcast: ${truncateMiddle(result.txid, 10, 8)}`);
      setRecipient("");
      setAmountInput("");
      setSelectedOutpoints([]);
      setReviewing(false);
      await load();
    } catch (e) {
      const err = isAppError(e) ? e : null;
      pushToast("error", err?.message ?? "Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4 border-line-strong p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-danger/40 bg-danger/[0.08] text-danger">
            <ArrowUpRight size={15} strokeWidth={2} />
          </span>
          <h2 className="font-header text-[15px] font-bold text-foreground">Send</h2>
        </div>
        <span className="text-[11px] text-subtle">
          Spendable: <SatsAmount sats={balances?.spendable ?? 0} className="text-foreground" />
        </span>
      </div>

      {!walletReadyToSpend && (
        <div className="rounded-control border border-warning/35 bg-warning/[0.08] px-3.5 py-2.5 text-[12px] text-warning">
          {walletSyncStatus === "error"
            ? `Sending disabled: ${walletSyncError ?? "wallet synchronization failed."}`
            : "Sending is enabled after the initial wallet sync completes."}
        </div>
      )}

      <TextField
        label="Recipient Address"
        placeholder="bc1… or tb1…"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        error={recipientError}
        hint={
          recipientValidation === "checking"
            ? "Checking address…"
            : recipientValidation === "valid"
              ? "Valid Bitcoin address. Network is checked before sending."
              : undefined
        }
        autoComplete="off"
        spellCheck={false}
      />

      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <TextField
          label="Amount"
          inputMode="decimal"
          placeholder="0"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          error={amountError}
        />
        <SegmentedToggle
          groupId="send-unit"
          value={unit}
          onChange={changeUnit}
          options={[
            { value: "sats", label: "sats" },
            { value: "btc", label: "BTC" },
            { value: "usd", label: "USD", disabled: btcPrice === null, title: btcPrice === null ? "BTC price unavailable" : undefined },
          ]}
        />
      </div>
      {!amountError && (
        <div className="-mt-2 flex items-center justify-between px-1 text-[11px] text-subtle">
          <span>{formatUnitAmount(amountSats, otherUnits[0], btcPrice) ?? "—"}</span>
          <span>{formatUnitAmount(amountSats, otherUnits[1], btcPrice) ?? "—"}</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Fee Rate</span>
        <div className="grid grid-cols-4 gap-2">
          {(["low", "mid", "high"] as const).map((key) => (
            <PresetTile
              key={key}
              onClick={() => setFeeKey(key)}
              selected={feeKey === key}
              label={key === "mid" ? "Medium" : key}
              value={fees ? `${formatFeeRate(fees[key])} s/vB` : "…"}
              size="sm"
            />
          ))}
          <PresetTile
            onClick={() => setFeeKey("custom")}
            selected={feeKey === "custom"}
            label="Custom"
            size="sm"
          />
        </div>
        {feeKey === "custom" && (
          <TextField
            label="Custom rate (sats/vB)"
            inputMode="decimal"
            placeholder="e.g. 8"
            value={customFeeRate}
            onChange={(e) => setCustomFeeRate(e.target.value)}
          />
        )}
      </div>

      <details className="border-t border-dashed border-line pt-3">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle marker:content-none hover:text-foreground">
          <ChevronDown size={12} strokeWidth={2.5} />
          Manual UTXO Picker
        </summary>
        <div className="mt-3 flex flex-col gap-2.5">
          <p className="text-[11.5px] text-subtle">Leave nothing selected to let the wallet auto-select coins.</p>
          <div className="flex max-h-45 flex-col gap-1.5 overflow-y-auto">
            {spendableUtxos.length === 0 && <p className="text-[11.5px] text-subtle">No spendable UTXOs.</p>}
            {spendableUtxos.map((u) => {
              const key = `${u.txid}:${u.vout}`;
              const checked = selectedOutpoints.some((o) => `${o.txid}:${o.vout}` === key);
              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-control border border-line bg-surface-raised px-3 py-2"
                >
                  <span className="flex items-center gap-2 truncate font-mono text-[11px] text-muted">
                    <input type="checkbox" checked={checked} onChange={() => toggleOutpoint(u)} className="accent-primary" />
                    {truncateMiddle(u.txid, 8, 6)}:{u.vout}
                    <span className="rounded-control border border-line px-1.5 py-0.5 text-[9px] text-subtle">
                      {classifySpendType(u.spendType)}
                    </span>
                  </span>
                  <SatsAmount sats={u.amountSats} className="flex-none text-[11px] font-semibold text-foreground" />
                </label>
              );
            })}
          </div>
          {selectedOutpoints.length > 0 && (
            <p className="text-[11.5px] text-subtle">
              Selected: <SatsAmount sats={selectedTotal} className="text-foreground" />
            </p>
          )}
        </div>
      </details>

      <div className="flex-1" />

      <Button size="md" disabled={!canReview} onClick={() => setReviewing(true)}>
        Review &amp; Send
      </Button>

      {reviewing && (
        <Modal
          title="Confirm send"
          onClose={() => !sending && setReviewing(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setReviewing(false)} disabled={sending}>
                Cancel
              </Button>
              <Button onClick={() => void confirmSend()} loading={sending} disabled={!walletReadyToSpend}>
                Confirm &amp; Broadcast
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2.5 text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-subtle">To</span>
              <span className="truncate font-mono text-foreground" title={recipient}>
                {truncateMiddle(recipient, 14, 8)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-subtle">Amount</span>
              <SatsAmount sats={amountSats} className="font-semibold text-foreground" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-subtle">Fee rate</span>
              <strong className="font-mono text-foreground">{formatFeeRate(feeRate)} s/vB</strong>
            </div>
            {selectedOutpoints.length > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-subtle">Coins selected</span>
                <strong className="font-mono text-foreground">{selectedOutpoints.length}</strong>
              </div>
            )}
          </div>
          <p className="mt-1 text-[11px] text-subtle">
            The exact network fee is determined when the transaction is built — this broadcasts immediately, there is no
            separate signing step.
          </p>
        </Modal>
      )}
    </Card>
  );
}

function ReceivePanel() {
  const pushToast = useToastStore((s) => s.push);
  const [addressType, setAddressType] = useState<AddressType>("p2wpkh");
  const [current, setCurrent] = useState<NewAddress | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [transactions, setTransactions] = useState<TxSummary[]>([]);

  const generate = useCallback(
    async (type: AddressType) => {
      setGenerating(true);
      try {
        const next = await getNewAddress(type);
        setCurrent(next);
      } catch (e) {
        pushToast("error", (e as { message?: string })?.message ?? "Failed to generate address.");
      } finally {
        setGenerating(false);
      }
    },
    [pushToast],
  );

  useEffect(() => {
    void generate(addressType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressType]);

  useEffect(() => {
    void getTransactions(100, 0).then(setTransactions);
  }, []);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    void QRCode.toDataURL(current.address, { width: 184, margin: 1 }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [current]);

  const recentAddresses = useMemo(() => {
    const seen = new Map<string, number>();
    for (const tx of transactions) {
      if (!tx.address || tx.amountSats <= 0) continue;
      seen.set(tx.address, (seen.get(tx.address) ?? 0) + tx.amountSats);
    }
    return [...seen.entries()].slice(0, 8);
  }, [transactions]);

  function copyAddress() {
    if (!current) return;
    void navigator.clipboard.writeText(current.address);
    pushToast("success", "Address copied.");
  }

  function exportCsv() {
    const rows = ["address,received_sats", ...recentAddresses.map(([addr, sats]) => `${addr},${sats}`)];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "receive-addresses.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="flex flex-col gap-4 border-line-strong p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-success/40 bg-success/[0.08] text-success">
            <ArrowDownLeft size={15} strokeWidth={2} />
          </span>
          <h2 className="font-header text-[15px] font-bold text-foreground">Receive</h2>
        </div>
      </div>

      <SegmentedToggle
        groupId="address-type"
        value={addressType}
        onChange={setAddressType}
        options={[
          { value: "p2wpkh", label: "SegWit" },
          { value: "p2tr", label: "Taproot" },
        ]}
      />

      <div className="flex justify-center py-1">
        <div className="grid h-[212px] w-[212px] place-items-center rounded-card bg-white p-3.5 shadow-[0_0_0_1px_rgba(255,255,255,0.16)]">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="Receive address QR code" width={184} height={184} />
          ) : (
            <RefreshCw size={24} strokeWidth={1.8} className="animate-spin text-subtle" />
          )}
        </div>
      </div>

      <label className="flex flex-col gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle">Your Address</span>
        <div className="flex h-[46px] items-center justify-between gap-2 rounded-control border border-line-strong bg-surface-raised px-3.5">
          <span className="truncate font-mono text-[12.5px] text-muted" title={current?.address}>
            {current ? truncateMiddle(current.address, 14, 10) : generating ? "Generating…" : "—"}
          </span>
          <button
            type="button"
            onClick={copyAddress}
            disabled={!current}
            className="grid h-[26px] w-[26px] flex-none place-items-center rounded text-subtle hover:bg-primary/10 hover:text-primary disabled:opacity-40"
          >
            <Copy size={13} strokeWidth={2} />
          </button>
        </div>
      </label>

      <Button variant="secondary" onClick={() => void generate(addressType)} loading={generating}>
        Generate New Address
      </Button>

      <details className="border-t border-dashed border-line pt-3">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-subtle marker:content-none hover:text-foreground">
          <ChevronDown size={12} strokeWidth={2.5} />
          Recent Addresses
        </summary>
        <div className="mt-3 flex flex-col divide-y divide-line">
          {recentAddresses.length === 0 && <p className="py-2 text-[11.5px] text-subtle">No incoming transactions yet.</p>}
          {recentAddresses.map(([addr, sats]) => (
            <div key={addr} className="flex items-center justify-between gap-3 py-2 text-[11.5px]">
              <span className="truncate font-mono text-muted" title={addr}>
                {truncateMiddle(addr, 10, 6)}
              </span>
              <SatsAmount sats={sats} className="flex-none font-semibold text-success" />
            </div>
          ))}
        </div>
        {recentAddresses.length > 0 && (
          <button
            type="button"
            onClick={exportCsv}
            className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-primary hover:text-primary-hover"
          >
            <Download size={12} strokeWidth={2} /> Export CSV
          </button>
        )}
      </details>

      <div className="flex-1" />
    </Card>
  );
}

export function SendPage() {
  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 pb-8 pt-2">
      <div className="shrink-0 pb-4">
        <h1 className="font-header text-[26px] font-bold text-foreground">Send &amp; Receive</h1>
        <p className="mt-1 text-[13.5px] text-muted">One shared balance — send a payment or generate a receiving address here.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SendPanel />
        <ReceivePanel />
      </div>
    </div>
  );
}
