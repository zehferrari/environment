export function statusPillClass(status: string | null | undefined) {
  if (status === "To Do") return "border-sky-500/70 bg-sky-100 text-sky-950 shadow-[inset_0_0_0_1px_rgba(2,132,199,0.18)]";
  if (status === "In Progress") return "border-emerald-500/70 bg-emerald-100 text-emerald-950 shadow-[inset_0_0_0_1px_rgba(5,150,105,0.18)]";
  if (status === "Review") return "border-amber-500/80 bg-amber-100 text-amber-950 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.22)]";
  if (status === "Done") return "border-lime-600/70 bg-lime-100 text-lime-950 shadow-[inset_0_0_0_1px_rgba(101,163,13,0.18)]";
  return "border-slate-500/60 bg-slate-100 text-slate-950 shadow-[inset_0_0_0_1px_rgba(71,85,105,0.16)]";
}

/** ENV-159: PM channel run lifecycle status labels and colors. */
export function pmRunStatusLabel(status: string): string {
  switch (status) {
    case "queued": return "Queued";
    case "claimed": return "Claimed";
    case "delivered": return "Delivered";
    case "waiting_capacity": return "Waiting (capacity)";
    case "accepted": return "Accepted (legacy)";
    case "admitted": return "Admitted";
    case "streaming": return "Streaming";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "timed_out": return "Timed out";
    case "cancelled": return "Cancelled";
    case "superseded": return "Superseded";
    default: return status;
  }
}

export function pmRunStatusColor(status: string): string {
  switch (status) {
    case "queued": return "text-slate-600";
    case "claimed": return "text-slate-500";
    case "delivered": return "text-blue-600";
    case "waiting_capacity": return "text-amber-600";
    case "accepted": return "text-slate-400";
    case "admitted": return "text-cyan-600";
    case "streaming": return "text-emerald-600";
    case "completed": return "text-lime-600";
    case "failed": return "text-red-600";
    case "timed_out": return "text-orange-600";
    case "cancelled": return "text-slate-400";
    case "superseded": return "text-purple-500";
    default: return "text-slate-500";
  }
}
