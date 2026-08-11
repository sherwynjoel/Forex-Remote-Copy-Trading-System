import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { SummaryCard } from "../components/SummaryCard";
import type { DashboardSummary, SystemHealth } from "../lib/types";

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  return `${Math.round(ms)} ms`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(1)}%`;
}

export function DashboardPage() {
  const { data: summary, error: summaryError } = usePolling<DashboardSummary>(() => api.get("/api/dashboard/summary"));
  const { data: health, error: healthError } = usePolling<SystemHealth>(() => api.get("/api/system/health"), 10000);

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100">Dashboard</h1>
      <p className="mt-1 text-sm text-slate-500">Overview of the copy-trading system.</p>

      {summaryError ? <p className="mt-4 text-sm text-red-400">{summaryError}</p> : null}

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <SummaryCard label="Total Masters" value={summary?.totalMasters ?? "—"} />
        <SummaryCard label="Total Slaves" value={summary?.totalSlaves ?? "—"} />
        <SummaryCard label="Online" value={summary?.onlineSlaves ?? "—"} />
        <SummaryCard label="Offline" value={summary?.offlineSlaves ?? "—"} />
        <SummaryCard label="Copying" value={summary?.copyingSlaves ?? "—"} />
        <SummaryCard label="Paused" value={summary?.pausedSlaves ?? "—"} />
        <SummaryCard label="Failed" value={summary?.failedSlaves ?? "—"} />
        <SummaryCard label="Trades Today" value={summary?.tradesToday ?? "—"} />
        <SummaryCard
          label="Success Rate"
          value={formatPercent(summary?.successRate ?? null)}
          hint={summary ? `${summary.successfulCopiesToday} executed / ${summary.failedCopiesToday} failed` : undefined}
        />
        <SummaryCard label="Avg Latency" value={formatLatency(summary?.avgLatencyMs ?? null)} />
      </div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-400">System Health</h2>
      {healthError ? (
        <p className="mt-2 text-sm text-red-400">{healthError}</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-3">
          {health &&
            Object.entries(health.components).map(([name, status]) => (
              <div key={name} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm">
                <span className={`h-2 w-2 rounded-full ${status === "ONLINE" ? "bg-emerald-500" : "bg-red-500"}`} />
                <span className="uppercase text-slate-400">{name}</span>
                <span className="text-slate-200">{status}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
