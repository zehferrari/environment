"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteBillingRateScheduleRow, saveBillingRateScheduleRow } from "@/lib/billing/rate-actions";

type Row = { id: string; startOn: string; amountCents: number };

function RateRow({
  row,
  scopeType,
  scopeId,
  onBusy,
}: {
  row: Row;
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
  onBusy: (work: () => Promise<void>) => void;
}) {
  const [startOn, setStartOn] = useState(row.startOn);
  const [amount, setAmount] = useState((row.amountCents / 100).toFixed(2));
  const values = () => {
    const form = new FormData();
    form.set("scopeType", scopeType);
    if (scopeId) form.set("scopeId", scopeId);
    if (row.id) form.set("id", row.id);
    form.set("startOn", startOn);
    form.set("amount", amount);
    return form;
  };
  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="px-3 py-2"><input type="date" value={startOn} onChange={(event) => setStartOn(event.target.value)} className="h-9 rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent" /></td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="150.00" className="h-9 w-36 rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent" />
          <div className="flex gap-2">
          {row.id ? <button type="button" onClick={() => onBusy(() => deleteBillingRateScheduleRow(values()))} className="text-caption text-text-muted hover:text-warn">Remove</button> : null}
          <button type="button" onClick={() => onBusy(() => saveBillingRateScheduleRow(values()))} className="rounded-lg bg-accent px-3 py-2 text-caption font-semibold text-bg hover:opacity-90">{row.id ? "Save" : "Add rate"}</button>
          </div>
        </div>
      </td>
    </tr>
  );
}

export default function BillingRateScheduleEditor({
  scopeType,
  scopeId,
  rows,
}: {
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
  rows: Row[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const onBusy = (work: () => Promise<void>) => {
    setError(null);
    startTransition(async () => {
      try {
        await work();
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to save the rate.");
      }
    });
  };
  return (
    <div className={`space-y-2 ${pending ? "opacity-70" : ""}`}>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-body">
          <thead><tr className="border-b border-line bg-panel-soft text-nano uppercase tracking-wider text-text-muted"><th className="px-3 py-2 text-left">Start on</th><th className="px-3 py-2 text-left">Amount / hour</th></tr></thead>
          <tbody>
            {rows.map((row) => <RateRow key={row.id} row={row} scopeType={scopeType} scopeId={scopeId} onBusy={onBusy} />)}
            <RateRow key={`new-${rows.length}`} row={{ id: "", startOn: new Date().toISOString().slice(0, 10), amountCents: 0 }} scopeType={scopeType} scopeId={scopeId} onBusy={onBusy} />
          </tbody>
        </table>
      </div>
      {error ? <p className="text-caption text-warn">{error}</p> : null}
      <p className="text-caption text-text-muted">The latest row whose start date is on or before the report period applies. Completed summaries keep their saved rate.</p>
    </div>
  );
}
