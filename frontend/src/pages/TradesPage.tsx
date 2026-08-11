import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAdminTradeFeed } from "../lib/ws";
import { DataTable, type Column } from "../components/DataTable";
import { StatusBadge } from "../components/StatusBadge";
import type { CopyOrder, CopyOrderBroadcast } from "../lib/types";

const MAX_ROWS = 200;

export function TradesPage() {
  const [rows, setRows] = useState<CopyOrder[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadInitial = useCallback(async () => {
    try {
      const data = await api.get<CopyOrder[]>("/api/copy-orders?limit=100");
      setRows(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useAdminTradeFeed((event: CopyOrderBroadcast) => {
    setRows((current) => {
      const existingIndex = current.findIndex((row) => row.id === event.copyId);
      const merged: CopyOrder = {
        id: event.copyId,
        tradeEventId: existingIndex >= 0 ? current[existingIndex]!.tradeEventId : "",
        masterId: event.masterId,
        slaveId: event.slaveId,
        masterTicket: event.masterTicket,
        type: event.type,
        status: event.status as CopyOrder["status"],
        requestedVolume: event.volume != null ? String(event.volume) : (existingIndex >= 0 ? current[existingIndex]!.requestedVolume : null),
        slaveTicket: event.slaveTicket ?? (existingIndex >= 0 ? current[existingIndex]!.slaveTicket : null),
        executionPrice: event.executionPrice != null ? String(event.executionPrice) : (existingIndex >= 0 ? current[existingIndex]!.executionPrice : null),
        errorReason: event.errorReason ?? null,
        sentAt: existingIndex >= 0 ? current[existingIndex]!.sentAt : null,
        executedAt: existingIndex >= 0 ? current[existingIndex]!.executedAt : null,
        createdAt: existingIndex >= 0 ? current[existingIndex]!.createdAt : event.timestamp,
        tradeEvent: { symbol: event.symbol, side: (event.side as "BUY" | "SELL") ?? null },
        master: existingIndex >= 0 ? current[existingIndex]!.master : undefined,
        slave: existingIndex >= 0 ? current[existingIndex]!.slave : undefined,
      };

      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = merged;
        return next;
      }
      return [merged, ...current].slice(0, MAX_ROWS);
    });
  });

  const columns: Column<CopyOrder>[] = [
    { header: "Time", render: (r) => new Date(r.createdAt).toLocaleTimeString() },
    { header: "Master Ticket", render: (r) => r.masterTicket },
    { header: "Symbol", render: (r) => r.tradeEvent?.symbol ?? "—" },
    { header: "Side", render: (r) => r.tradeEvent?.side ?? "—" },
    { header: "Type", render: (r) => r.type },
    { header: "Volume", render: (r) => r.requestedVolume ?? "—" },
    { header: "Slave Ticket", render: (r) => r.slaveTicket ?? "—" },
    { header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { header: "Reason", render: (r) => r.errorReason ?? "—" },
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100">Live Trades</h1>
      <p className="mt-1 text-sm text-slate-500">Updates in real time as trades are copied — no refresh needed.</p>
      {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
      <div className="mt-6">
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} emptyMessage="No trades yet." />
      </div>
    </div>
  );
}
