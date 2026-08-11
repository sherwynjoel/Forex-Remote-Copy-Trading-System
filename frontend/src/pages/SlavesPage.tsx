import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { DataTable, type Column } from "../components/DataTable";
import { StatusBadge } from "../components/StatusBadge";
import type { Slave } from "../lib/types";

export function SlavesPage() {
  const navigate = useNavigate();
  const { data: slaves, error, refetch } = usePolling<Slave[]>(() => api.get("/api/slaves"));

  async function togglePause(slave: Slave, event: React.MouseEvent) {
    event.stopPropagation();
    await api.patch(`/api/slaves/${slave.id}`, { copyEnabled: !slave.copyEnabled });
    void refetch();
  }

  const columns: Column<Slave>[] = [
    { header: "Name", render: (s) => s.name },
    { header: "Account", render: (s) => s.accountNumber },
    { header: "Master", render: (s) => s.masterId.slice(0, 8) },
    { header: "Status", render: (s) => <StatusBadge status={s.status} /> },
    { header: "Copy Mode", render: (s) => s.copyMode },
    { header: "Multiplier", render: (s) => s.multiplier },
    {
      header: "Copying",
      render: (s) => (
        <button
          onClick={(e) => togglePause(s, e)}
          className={`rounded px-2 py-1 text-xs font-medium ${
            s.copyEnabled ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25" : "bg-slate-700/50 text-slate-400 hover:bg-slate-700"
          }`}
        >
          {s.copyEnabled ? "Copying — pause" : "Paused — resume"}
        </button>
      ),
    },
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100">Slaves</h1>
      {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
      <div className="mt-6">
        <DataTable
          columns={columns}
          rows={slaves ?? []}
          rowKey={(s) => s.id}
          emptyMessage="No Slaves registered yet."
          onRowClick={(s) => navigate(`/slaves/${s.id}`)}
        />
      </div>
    </div>
  );
}
