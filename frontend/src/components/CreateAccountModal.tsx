import { useState, type FormEvent } from "react";
import { api } from "../lib/api";

type Kind = "master" | "slave";

interface CreateAccountModalProps {
  kind: Kind;
  /** Required when kind === "slave" — which Master this Slave copies from. */
  masterId?: string;
  onClose: () => void;
  onCreated: () => void;
}

interface CreatedConnector {
  token: string;
}

/**
 * Registers a new Master or Slave, then immediately registers a connector
 * for it and shows the resulting bearer token — the token is only ever
 * returned once by the backend (only its hash is persisted), so this is
 * the one chance to copy it into the EA/Slave service config.
 */
export function CreateAccountModal({ kind, masterId, onClose, onCreated }: CreateAccountModalProps) {
  const [name, setName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [broker, setBroker] = useState("");
  const [platform, setPlatform] = useState<"MT4" | "MT5">("MT5");
  const [server, setServer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedConnector | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const entity =
        kind === "master"
          ? await api.post<{ id: string }>("/api/masters", { name, accountNumber, broker, platform, server })
          : await api.post<{ id: string }>("/api/slaves", { masterId, name, accountNumber, broker, platform, server });

      const connectorPath = kind === "master" ? `/api/masters/${entity.id}/connectors` : `/api/slaves/${entity.id}/connectors`;
      const connector = await api.post<{ token: string }>(connectorPath, { version: "1.0.0" });

      setCreated({ token: connector.token });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToken() {
    if (!created) return;
    await navigator.clipboard.writeText(created.token);
    setCopied(true);
  }

  const label = kind === "master" ? "Master" : "Slave";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-900 p-6">
        {created ? (
          <>
            <h2 className="text-lg font-semibold text-slate-100">{label} created</h2>
            <p className="mt-1 text-sm text-slate-500">
              Copy this connector token now — the backend only shows it once. Paste it into the
              {kind === "master" ? " EA's ConnectorToken" : " Slave EA/service's ConnectorToken (or CONNECTOR_TOKEN)"} input.
            </p>
            <div className="mt-4 break-all rounded border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-200">
              {created.token}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={copyToken}
                className="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-white"
              >
                {copied ? "Copied" : "Copy token"}
              </button>
              <button onClick={onClose} className="rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700">
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <h2 className="text-lg font-semibold text-slate-100">Add {label}</h2>

            <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-400">Name</label>
            <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />

            <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-400">Account Number</label>
            <input className="input mt-1" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} required />

            <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-400">Broker</label>
            <input className="input mt-1" value={broker} onChange={(e) => setBroker(e.target.value)} required placeholder="Exness" />

            <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-400">Platform</label>
            <select className="input mt-1" value={platform} onChange={(e) => setPlatform(e.target.value as "MT4" | "MT5")}>
              <option value="MT5">MT5</option>
              <option value="MT4">MT4</option>
            </select>

            <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-400">Server</label>
            <input
              className="input mt-1"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              required
              placeholder={platform === "MT4" ? "Exness-MT4Real17" : "Exness-MT5Real17"}
            />

            {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

            <div className="mt-5 flex items-center gap-3">
              <button
                type="submit"
                disabled={submitting}
                className="rounded bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-50"
              >
                {submitting ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
