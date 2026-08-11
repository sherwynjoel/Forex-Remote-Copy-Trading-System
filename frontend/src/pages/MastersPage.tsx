import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { DataTable, type Column } from "../components/DataTable";
import { StatusBadge } from "../components/StatusBadge";
import type { Master } from "../lib/types";

export function MastersPage() {
  const navigate = useNavigate();
  const { data: masters, error } = usePolling<Master[]>(() => api.get("/api/masters"));

  const columns: Column<Master>[] = [
    { header: "Name", render: (m) => m.name },
    { header: "Account", render: (m) => m.accountNumber },
    { header: "Broker", render: (m) => m.broker },
    { header: "Status", render: (m) => <StatusBadge status={m.status} /> },
    { header: "Connector", render: (m) => <StatusBadge status={m.connectors?.[0]?.status ?? "OFFLINE"} /> },
    { header: "Slaves", render: (m) => m.slaves?.length ?? "—" },
    { header: "Balance", render: (m) => (m.balance ? Number(m.balance).toFixed(2) : "—") },
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100">Masters</h1>
      {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
      <div className="mt-6">
        <DataTable
          columns={columns}
          rows={masters ?? []}
          rowKey={(m) => m.id}
          emptyMessage="No Masters registered yet."
          onRowClick={(m) => navigate(`/masters/${m.id}`)}
        />
      </div>
    </div>
  );
}
