import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { StatusBadge } from "../components/StatusBadge";
import { DataTable, type Column } from "../components/DataTable";
import { CreateAccountModal } from "../components/CreateAccountModal";
import type { Master, Slave } from "../lib/types";

export function MasterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: master, error, refetch } = usePolling<Master>(() => api.get(`/api/masters/${id}`));
  const [showCreate, setShowCreate] = useState(false);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!master) return <p className="text-sm text-slate-500">Loading…</p>;

  const slaveColumns: Column<Slave>[] = [
    { header: "Name", render: (s) => s.name },
    { header: "Account", render: (s) => s.accountNumber },
    { header: "Status", render: (s) => <StatusBadge status={s.status} /> },
    { header: "Copy", render: (s) => <StatusBadge status={s.copyEnabled ? "ACTIVE" : "PAUSED"} /> },
    { header: "Mode", render: (s) => s.copyMode },
  ];

  return (
    <div>
      <Link to="/masters" className="text-sm text-slate-500 hover:text-slate-300">
        ← Masters
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-slate-100">{master.name}</h1>
      <p className="mt-1 text-sm text-slate-500">
        {master.accountNumber} · {master.broker} · {master.server}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Status" value={<StatusBadge status={master.status} />} />
        <Stat label="Connector" value={<StatusBadge status={master.connectors?.[0]?.status ?? "OFFLINE"} />} />
        <Stat label="Balance" value={master.balance ? Number(master.balance).toFixed(2) : "—"} />
        <Stat label="Equity" value={master.equity ? Number(master.equity).toFixed(2) : "—"} />
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Assigned Slaves ({master.slaves?.length ?? 0})
        </h2>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-white"
        >
          + Add Slave
        </button>
      </div>
      <div className="mt-2">
        <DataTable
          columns={slaveColumns}
          rows={master.slaves ?? []}
          rowKey={(s) => s.id}
          emptyMessage="No Slaves assigned to this Master."
          onRowClick={(s) => navigate(`/slaves/${s.id}`)}
        />
      </div>

      {showCreate ? (
        <CreateAccountModal kind="slave" masterId={master.id} onClose={() => setShowCreate(false)} onCreated={refetch} />
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-lg text-slate-100">{value}</div>
    </div>
  );
}
