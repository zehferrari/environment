export function statusPillClass(status: string | null | undefined) {
  if (status === "To Do") return "border-sky-500/70 bg-sky-100 text-sky-950 shadow-[inset_0_0_0_1px_rgba(2,132,199,0.18)]";
  if (status === "In Progress") return "border-emerald-500/70 bg-emerald-100 text-emerald-950 shadow-[inset_0_0_0_1px_rgba(5,150,105,0.18)]";
  if (status === "Review") return "border-amber-500/80 bg-amber-100 text-amber-950 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.22)]";
  if (status === "Done") return "border-lime-600/70 bg-lime-100 text-lime-950 shadow-[inset_0_0_0_1px_rgba(101,163,13,0.18)]";
  return "border-slate-500/60 bg-slate-100 text-slate-950 shadow-[inset_0_0_0_1px_rgba(71,85,105,0.16)]";
}
