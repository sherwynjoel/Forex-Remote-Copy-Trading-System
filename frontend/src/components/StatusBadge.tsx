const COLORS: Record<string, string> = {
  ONLINE: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  EXECUTED: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  ACTIVE: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  SENT: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",

  OFFLINE: "bg-slate-500/15 text-slate-400 ring-slate-500/30",
  DISABLED: "bg-slate-500/15 text-slate-400 ring-slate-500/30",
  PAUSED: "bg-slate-500/15 text-slate-400 ring-slate-500/30",

  CONNECTING: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  PENDING: "bg-amber-500/15 text-amber-400 ring-amber-500/30",

  ERROR: "bg-red-500/15 text-red-400 ring-red-500/30",
  FAILED: "bg-red-500/15 text-red-400 ring-red-500/30",
  REJECTED: "bg-red-500/15 text-red-400 ring-red-500/30",
};

export function StatusBadge({ status }: { status: string }) {
  const colorClass = COLORS[status] ?? "bg-slate-500/15 text-slate-400 ring-slate-500/30";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${colorClass}`}>
      {status}
    </span>
  );
}
