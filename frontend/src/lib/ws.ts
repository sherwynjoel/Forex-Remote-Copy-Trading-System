import { useEffect, useRef } from "react";
import { wsUrl } from "./api";
import type { CopyOrderBroadcast } from "./types";

const RECONNECT_DELAY_MS = 3000;

/**
 * Subscribes to /ws/admin for the lifetime of the component. Real-time
 * push is scoped to the Live Trades page only for this MVP — everything
 * else in the dashboard polls (see docs/ARCHITECTURE.md).
 */
export function useAdminTradeFeed(onEvent: (event: CopyOrderBroadcast) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function connect() {
      if (stopped) return;
      socket = new WebSocket(wsUrl("/ws/admin"));

      socket.onmessage = (event) => {
        try {
          onEventRef.current(JSON.parse(event.data));
        } catch {
          // ignore malformed frames
        }
      };

      socket.onclose = () => {
        if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);
}
