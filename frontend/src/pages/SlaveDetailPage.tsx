import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { StatusBadge } from "../components/StatusBadge";
import type { CopyMode, Slave } from "../lib/types";

const COPY_MODES: CopyMode[] = ["FIXED_LOT", "MULTIPLIER", "BALANCE_PROPORTIONAL", "EQUITY_PROPORTIONAL"];

export function SlaveDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: slave, error, refetch } = usePolling<Slave>(() => api.get(`/api/slaves/${id}`));

  const [form, setForm] = useState<Partial<Slave> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Only seed the editable form once per fresh load — polling refreshes
  // `slave` in the background, but that shouldn't clobber in-progress edits.
  useEffect(() => {
    if (slave && form === null) setForm(slave);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slave]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!slave || !form) return <p className="text-sm text-slate-500">Loading…</p>;

  async function save() {
    if (!form) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      await api.patch(`/api/slaves/${id}`, {
        copyMode: form.copyMode,
        multiplier: form.multiplier ? Number(form.multiplier) : undefined,
        fixedLot: form.fixedLot ? Number(form.fixedLot) : undefined,
        minLot: form.minLot ? Number(form.minLot) : undefined,
        maxLot: form.maxLot ? Number(form.maxLot) : undefined,
        lotStep: form.lotStep ? Number(form.lotStep) : undefined,
        emergencyStop: form.emergencyStop,
        maxPositions: form.maxPositions ?? undefined,
        maxExposure: form.maxExposure ? Number(form.maxExposure) : undefined,
      });
      setSaveMessage("Saved.");
      void refetch();
    } catch {
      setSaveMessage("Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePause() {
    await api.patch(`/api/slaves/${id}`, { copyEnabled: !slave!.copyEnabled });
    void refetch();
  }

  return (
    <div className="max-w-2xl">
      <Link to="/slaves" className="text-sm text-slate-500 hover:text-slate-300">
        ← Slaves
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-slate-100">{slave.name}</h1>
      <p className="mt-1 text-sm text-slate-500">
        {slave.accountNumber} · {slave.broker} · {slave.server}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={slave.status} />
        <StatusBadge status={slave.copyEnabled ? "ACTIVE" : "PAUSED"} />
        <button onClick={togglePause} className="rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700">
          {slave.copyEnabled ? "Pause copying" : "Resume copying"}
        </button>
      </div>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-400">Volume Config</h2>
      <div className="mt-2 grid grid-cols-2 gap-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <Field label="Copy Mode">
          <select
            className="input"
            value={form.copyMode}
            onChange={(e) => setForm({ ...form, copyMode: e.target.value as CopyMode })}
          >
            {COPY_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Multiplier">
          <input className="input" value={form.multiplier ?? ""} onChange={(e) => setForm({ ...form, multiplier: e.target.value })} />
        </Field>
        <Field label="Fixed Lot">
          <input className="input" value={form.fixedLot ?? ""} onChange={(e) => setForm({ ...form, fixedLot: e.target.value })} />
        </Field>
        <Field label="Min Lot">
          <input className="input" value={form.minLot ?? ""} onChange={(e) => setForm({ ...form, minLot: e.target.value })} />
        </Field>
        <Field label="Max Lot">
          <input className="input" value={form.maxLot ?? ""} onChange={(e) => setForm({ ...form, maxLot: e.target.value })} />
        </Field>
        <Field label="Lot Step">
          <input className="input" value={form.lotStep ?? ""} onChange={(e) => setForm({ ...form, lotStep: e.target.value })} />
        </Field>
      </div>

      <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-400">Risk Limits</h2>
      <div className="mt-2 grid grid-cols-2 gap-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <Field label="Max Positions">
          <input
            className="input"
            value={form.maxPositions ?? ""}
            onChange={(e) => setForm({ ...form, maxPositions: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <Field label="Max Exposure">
          <input className="input" value={form.maxExposure ?? ""} onChange={(e) => setForm({ ...form, maxExposure: e.target.value })} />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={form.emergencyStop ?? false}
            onChange={(e) => setForm({ ...form, emergencyStop: e.target.checked })}
          />
          Emergency stop (blocks new OPENs; existing positions can still CLOSE)
        </label>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saveMessage ? <span className="text-sm text-slate-400">{saveMessage}</span> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
