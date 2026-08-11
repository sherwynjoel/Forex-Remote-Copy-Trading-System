// Mirrors the backend's Prisma models as they actually arrive over JSON —
// note Decimal fields (balance, multiplier, minLot, ...) serialize as
// strings, not numbers, since Prisma's Decimal has no native JSON type.

export type SlaveStatus = "ONLINE" | "OFFLINE" | "CONNECTING" | "ERROR" | "DISABLED";
export type ConnectorStatus = "ONLINE" | "OFFLINE" | "CONNECTING" | "ERROR";
export type CopyMode = "FIXED_LOT" | "MULTIPLIER" | "BALANCE_PROPORTIONAL" | "EQUITY_PROPORTIONAL";
export type CopyOrderStatus = "PENDING" | "SENT" | "EXECUTED" | "FAILED" | "REJECTED";
export type TradeEventType = "OPEN" | "CLOSE" | "MODIFY" | "PARTIAL_CLOSE" | "PENDING_OPEN" | "PENDING_MODIFY" | "PENDING_CANCEL";

export interface Connector {
  id: string;
  status: ConnectorStatus;
  lastHeartbeatAt: string | null;
}

export interface Master {
  id: string;
  name: string;
  accountNumber: string;
  broker: string;
  platform: string;
  server: string;
  status: "ACTIVE" | "DISABLED";
  balance: string | null;
  equity: string | null;
  createdAt: string;
  connectors?: Connector[];
  slaves?: Slave[];
}

export interface Slave {
  id: string;
  masterId: string;
  name: string;
  accountNumber: string;
  broker: string;
  platform: string;
  server: string;
  status: SlaveStatus;
  copyEnabled: boolean;
  copyMode: CopyMode;
  fixedLot: string | null;
  multiplier: string;
  minLot: string;
  maxLot: string;
  lotStep: string;
  balance: string | null;
  equity: string | null;
  emergencyStop: boolean;
  allowedSymbols: string[];
  blockedSymbols: string[];
  maxPositions: number | null;
  maxExposure: string | null;
  createdAt: string;
  connectors?: Connector[];
}

export interface CopyOrder {
  id: string;
  tradeEventId: string;
  masterId: string;
  slaveId: string;
  masterTicket: string;
  type: TradeEventType;
  status: CopyOrderStatus;
  requestedVolume: string | null;
  slaveTicket: string | null;
  executionPrice: string | null;
  errorReason: string | null;
  sentAt: string | null;
  executedAt: string | null;
  createdAt: string;
  tradeEvent?: { symbol: string; side: "BUY" | "SELL" | null };
  master?: { name: string; accountNumber: string };
  slave?: { name: string; accountNumber: string };
}

export interface DashboardSummary {
  totalMasters: number;
  totalSlaves: number;
  onlineSlaves: number;
  offlineSlaves: number;
  copyingSlaves: number;
  pausedSlaves: number;
  failedSlaves: number;
  tradesToday: number;
  successfulCopiesToday: number;
  failedCopiesToday: number;
  successRate: number | null;
  avgLatencyMs: number | null;
}

export interface SystemHealth {
  status: "ONLINE" | "DEGRADED";
  components: { api: string; database: string; redis: string };
  timestamp: string;
}

/** Live broadcast shape from /ws/admin — see copyEngine.ts::broadcastCopyOrder. */
export interface CopyOrderBroadcast {
  copyId: string;
  masterId: string;
  slaveId: string;
  masterTicket: string;
  type: TradeEventType;
  status: string;
  symbol: string;
  side?: string;
  volume?: number;
  slaveTicket?: string;
  executionPrice?: number;
  errorReason?: string;
  timestamp: string;
}
