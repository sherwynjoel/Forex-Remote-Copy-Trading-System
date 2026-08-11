import type { ReactNode } from "react";

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
}

/** Deliberately no grid library — a plain table is fast-loading and matches spec's "not a marketing website" guidance. */
export function DataTable<T>({ columns, rows, rowKey, emptyMessage = "No data", onRowClick }: DataTableProps<T>) {
  if (rows.length === 0) {
    return <div className="rounded-lg border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-500">{emptyMessage}</div>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="min-w-full divide-y divide-slate-800 text-sm">
        <thead className="bg-slate-900">
          <tr>
            {columns.map((col) => (
              <th key={col.header} className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400 ${col.className ?? ""}`}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800 bg-slate-950">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? "cursor-pointer hover:bg-slate-900" : ""}
            >
              {columns.map((col) => (
                <td key={col.header} className={`px-3 py-2 text-slate-200 ${col.className ?? ""}`}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
