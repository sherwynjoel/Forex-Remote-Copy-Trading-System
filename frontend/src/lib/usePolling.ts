import { useCallback, useEffect, useState } from "react";

const DEFAULT_INTERVAL_MS = 7000;

/**
 * Refetches on an interval — the MVP's deliberate choice for everything
 * except the Live Trades page (which uses the real /ws/admin push
 * channel instead; see lib/ws.ts). Simple and sufficient for data that
 * doesn't need sub-second freshness.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = DEFAULT_INTERVAL_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const result = await fetcher();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refetch();
    const interval = setInterval(refetch, intervalMs);
    return () => clearInterval(interval);
  }, [refetch, intervalMs]);

  return { data, error, loading, refetch };
}
