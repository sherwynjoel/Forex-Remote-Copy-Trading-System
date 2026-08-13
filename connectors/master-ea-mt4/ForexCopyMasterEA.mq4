//+------------------------------------------------------------------+
//| ForexCopyMasterEA.mq4                                            |
//| Master connector for the Forex Remote Copy Trading System — MT4  |
//| variant.                                                          |
//|                                                                    |
//| Same responsibility as the MT5 EA (detect -> normalize ->        |
//| transmit, no volume/risk logic here) and the same wire format —  |
//| this file sends the exact same event shape to the exact same     |
//| POST /api/ingest/trade-event endpoint, so the backend needed zero |
//| changes to accept it.                                             |
//|                                                                    |
//| The one real difference from the MT5 EA: MQL4 has no              |
//| OnTradeTransaction() (or any account-wide trade event at all).   |
//| Detection here works by taking a snapshot of every open/pending  |
//| order on a timer and diffing it against the previous snapshot —  |
//| driven by a millisecond timer rather than OnTick() specifically  |
//| because OnTick() only fires for the symbol of the chart this EA  |
//| is attached to, which would miss trades on every other symbol.   |
//| A ~500ms timer catches every symbol, at the cost of being         |
//| genuinely polling-based rather than a native push event — the    |
//| honest MT4 tradeoff, not a shortcut.                              |
//+------------------------------------------------------------------+
#property copyright "Forex Remote Copy Trading System"
#property version   "1.00"
#property strict

#include <ForexCopy/Json.mqh>
#include <ForexCopy/Http.mqh>

input string BackendUrl                 = "http://localhost:4000"; // must be allow-listed: Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL
input string ConnectorToken             = "";                      // from POST /api/masters/:id/connectors
input int    HeartbeatIntervalSeconds   = 5;
input int    TimerIntervalMs            = 500;                     // detection-scan + retry-queue cadence — this is the real "how fast do we notice a trade" number on MT4
input int    BrokerGmtOffsetHours       = 0;                       // set to your broker server's UTC offset so latency timestamps are accurate

// One open order/position or pending order, as of the last scan.
struct OrderSnapshot
  {
   int               ticket;
   string            symbol;
   int               type;      // OP_BUY .. OP_SELLSTOP
   double            lots;
   double            openPrice;
   double            sl;
   double            tp;
  };

HttpClient     http;
// Wall-clock milliseconds (GetTickCount64()), not TimeCurrent() — the
// latter is the symbol's last known tick time, which stalls whenever no
// new price ticks arrive, silently freezing anything scheduled off it.
ulong          g_lastHeartbeatMs = 0;
long           g_accountLogin  = 0;
int            g_eventSeq      = 0;
OrderSnapshot  g_openSnapshot[];      // last-known open market positions (OP_BUY/OP_SELL)
OrderSnapshot  g_pendingSnapshot[];   // last-known pending orders

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(ConnectorToken) == 0)
     {
      Print("ForexCopy: ConnectorToken input is empty. Register a connector via POST /api/masters/:id/connectors first.");
      return(INIT_PARAMETERS_INCORRECT);
     }

   g_accountLogin = AccountNumber();
   http.Init(BackendUrl, ConnectorToken);

   // Baseline the snapshot on startup without sending anything — otherwise
   // every pre-existing open trade would be reported as a brand-new OPEN
   // the moment the EA attaches. From here on, only *changes* are sent.
   BuildCurrentSnapshots(g_openSnapshot, g_pendingSnapshot);

   EventSetMillisecondTimer(TimerIntervalMs);
   PrintFormat("ForexCopy Master EA (MT4) initialized for account %d, backend=%s, scan interval=%dms",
               g_accountLogin, BackendUrl, TimerIntervalMs);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   http.ProcessRetryQueue();
   ScanAndDetect();

   if(GetTickCount64() - g_lastHeartbeatMs >= (ulong)HeartbeatIntervalSeconds * 1000)
     {
      // Balance/equity/positions ride on the heartbeat since it already
      // flows every few seconds — this is the only source of that data for
      // BALANCE_PROPORTIONAL/EQUITY_PROPORTIONAL volume sizing and for
      // reconciliation's "Master state" (see docs/ARCHITECTURE.md).
      JsonBuilder hb;
      hb.AddNumber("balance", AccountBalance(), 2);
      hb.AddNumber("equity", AccountEquity(), 2);
      hb.AddRaw("positions", BuildPositionsJson());
      http.SendHeartbeat(hb.Build());
      g_lastHeartbeatMs = GetTickCount64();
     }
  }

//+------------------------------------------------------------------+
//| Snapshot + diff — the detection mechanism                        |
//+------------------------------------------------------------------+
bool IsPendingType(const int type)
  {
   return type == OP_BUYLIMIT || type == OP_SELLLIMIT || type == OP_BUYSTOP || type == OP_SELLSTOP;
  }

string SideFromType(const int type)
  {
   if(type == OP_BUY || type == OP_BUYLIMIT || type == OP_BUYSTOP)
      return "BUY";
   return "SELL";
  }

bool DoubleEquals(const double a, const double b)
  {
   return MathAbs(a - b) < 0.0000001;
  }

int FindByTicket(const OrderSnapshot &arr[], const int ticket)
  {
   for(int i = 0; i < ArraySize(arr); i++)
      if(arr[i].ticket == ticket)
         return i;
   return -1;
  }

void BuildCurrentSnapshots(OrderSnapshot &openOut[], OrderSnapshot &pendingOut[])
  {
   ArrayResize(openOut, 0);
   ArrayResize(pendingOut, 0);
   int total = OrdersTotal();

   for(int i = 0; i < total; i++)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
         continue;

      OrderSnapshot s;
      s.ticket    = OrderTicket();
      s.symbol    = OrderSymbol();
      s.type      = OrderType();
      s.lots      = OrderLots();
      s.openPrice = OrderOpenPrice();
      s.sl        = OrderStopLoss();
      s.tp        = OrderTakeProfit();

      if(s.type == OP_BUY || s.type == OP_SELL)
        {
         int n = ArraySize(openOut);
         ArrayResize(openOut, n + 1);
         openOut[n] = s;
        }
      else if(IsPendingType(s.type))
        {
         int n = ArraySize(pendingOut);
         ArrayResize(pendingOut, n + 1);
         pendingOut[n] = s;
        }
     }
  }

void ScanAndDetect()
  {
   OrderSnapshot currentOpen[];
   OrderSnapshot currentPending[];
   BuildCurrentSnapshots(currentOpen, currentPending);

   DetectOpenChanges(currentOpen);
   DetectPendingChanges(currentPending, currentOpen);

   // Struct-array-to-struct-array assignment via "=" isn't reliably
   // portable across MQL4/5 builds — copy element by element instead.
   CopySnapshotArray(currentOpen, g_openSnapshot);
   CopySnapshotArray(currentPending, g_pendingSnapshot);
  }

void CopySnapshotArray(const OrderSnapshot &src[], OrderSnapshot &dst[])
  {
   int n = ArraySize(src);
   ArrayResize(dst, n);
   for(int i = 0; i < n; i++)
      dst[i] = src[i];
  }

//+------------------------------------------------------------------+
//| Open positions: OPEN / PARTIAL_CLOSE / MODIFY / CLOSE             |
//+------------------------------------------------------------------+
void DetectOpenChanges(const OrderSnapshot &current[])
  {
   for(int i = 0; i < ArraySize(current); i++)
     {
      int prevIdx = FindByTicket(g_openSnapshot, current[i].ticket);
      if(prevIdx == -1)
        {
         // Wasn't open a moment ago. Whether it's a brand-new market order or
         // a pending order that just triggered, MT4 keeps the same ticket
         // number either way (unlike MT5's separate deal ticket) — from the
         // Slave's perspective both are simply a fresh OPEN.
         SendOpenEvent(current[i]);
         continue;
        }

      OrderSnapshot prev = g_openSnapshot[prevIdx];
      if(current[i].lots < prev.lots - 0.0000001)
        {
         SendPartialCloseEvent(current[i], prev.lots - current[i].lots);
        }
      else if(!DoubleEquals(current[i].sl, prev.sl) || !DoubleEquals(current[i].tp, prev.tp))
        {
         SendModifyEvent(current[i]);
        }
     }

   for(int i = 0; i < ArraySize(g_openSnapshot); i++)
     {
      if(FindByTicket(current, g_openSnapshot[i].ticket) == -1)
         SendCloseEvent(g_openSnapshot[i]);
     }
  }

// Best-effort lookup of the actual fill price for a full close, from
// history. Falls back to omitting price entirely (SendTradeEvent skips it
// when <= 0) rather than guessing — the Slave always executes at its own
// market price regardless, so this is informational/latency-dashboard
// data, never something execution correctness depends on.
double FindClosePrice(const int ticket)
  {
   if(OrderSelect(ticket, SELECT_BY_TICKET) && OrderCloseTime() > 0)
      return OrderClosePrice();
   return 0;
  }

// Best-effort lookup of the fill price for a specific partial close, by
// matching the closed-off lot size against recent history entries for the
// same ticket (MT4 records a partial close as a history row under the
// original ticket number).
double FindPartialClosePrice(const int ticket, const double closedVolume)
  {
   int total = OrdersHistoryTotal();
   int scanFloor = MathMax(0, total - 25); // only recent history — this ticket's partial just happened
   for(int i = total - 1; i >= scanFloor; i--)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY))
         continue;
      if(OrderTicket() != ticket)
         continue;
      if(MathAbs(OrderLots() - closedVolume) < 0.0000001)
         return OrderClosePrice();
     }
   return 0;
  }

void SendOpenEvent(const OrderSnapshot &o)
  {
   string eventId = "OPEN-" + IntegerToString(g_accountLogin) + "-" + IntegerToString(o.ticket);
   SendTradeEvent(eventId, "OPEN", o.symbol, SideFromType(o.type), o.lots, o.openPrice, o.sl, o.tp,
                  IntegerToString(o.ticket));
  }

void SendModifyEvent(const OrderSnapshot &o)
  {
   g_eventSeq++;
   string eventId = "MODIFY-" + IntegerToString(g_accountLogin) + "-" + IntegerToString(o.ticket) + "-" + IntegerToString(g_eventSeq);
   SendTradeEvent(eventId, "MODIFY", o.symbol, SideFromType(o.type), o.lots, 0, o.sl, o.tp,
                  IntegerToString(o.ticket));
  }

void SendPartialCloseEvent(const OrderSnapshot &o, const double closedVolume)
  {
   g_eventSeq++;
   double price = FindPartialClosePrice(o.ticket, closedVolume);
   string eventId = "PARTIAL-" + IntegerToString(g_accountLogin) + "-" + IntegerToString(o.ticket) + "-" + IntegerToString(g_eventSeq);
   SendTradeEvent(eventId, "PARTIAL_CLOSE", o.symbol, SideFromType(o.type), closedVolume, price, 0, 0,
                  IntegerToString(o.ticket));
  }

void SendCloseEvent(const OrderSnapshot &o)
  {
   double price = FindClosePrice(o.ticket);
   string eventId = "CLOSE-" + IntegerToString(g_accountLogin) + "-" + IntegerToString(o.ticket);
   SendTradeEvent(eventId, "CLOSE", o.symbol, SideFromType(o.type), o.lots, price, 0, 0,
                  IntegerToString(o.ticket));
  }

//+------------------------------------------------------------------+
//| Pending orders: PENDING_OPEN / PENDING_MODIFY / PENDING_CANCEL    |
//+------------------------------------------------------------------+
void DetectPendingChanges(const OrderSnapshot &current[], const OrderSnapshot &currentOpen[])
  {
   for(int i = 0; i < ArraySize(current); i++)
     {
      int prevIdx = FindByTicket(g_pendingSnapshot, current[i].ticket);
      if(prevIdx == -1)
        {
         SendPendingOpenEvent(current[i]);
         continue;
        }

      OrderSnapshot prev = g_pendingSnapshot[prevIdx];
      if(!DoubleEquals(current[i].openPrice, prev.openPrice) ||
         !DoubleEquals(current[i].sl, prev.sl) || !DoubleEquals(current[i].tp, prev.tp))
        {
         SendPendingModifyEvent(current[i]);
        }
     }

   for(int i = 0; i < ArraySize(g_pendingSnapshot); i++)
     {
      int ticket = g_pendingSnapshot[i].ticket;
      if(FindByTicket(current, ticket) != -1)
         continue; // still pending, handled above

      if(FindByTicket(currentOpen, ticket) != -1)
         continue; // triggered into a position — DetectOpenChanges already sent OPEN for it

      SendPendingCancelEvent(g_pendingSnapshot[i]);
     }
  }

void SendPendingOpenEvent(const OrderSnapshot &o)
  {
   string eventId = "PENDING-" + IntegerToString(g_accountLogin) + "-" + IntegerToString(o.ticket);
   SendTradeEvent(eventId, "PENDING_OPEN", o.symbol, SideFromType(o.type), o.lots, o.openPrice, o.sl, o.tp,
                  IntegerToString(o.ticket));
  }

void SendPendingModifyEvent(const OrderSnapshot &o)
  {
   g_eventSeq++;
   string eventId = "PENDINGMOD-" + IntegerToString(g_accountLogin) + "-" + IntegerToString(o.ticket) + "-" + IntegerToString(g_eventSeq);
   SendTradeEvent(eventId, "PENDING_MODIFY", o.symbol, SideFromType(o.type), o.lots, o.openPrice, o.sl, o.tp,
                  IntegerToString(o.ticket));
  }

void SendPendingCancelEvent(const OrderSnapshot &o)
  {
   string eventId = "PENDINGDEL-" + IntegerToString(g_accountLogin) + "-" + IntegerToString(o.ticket);
   SendTradeEvent(eventId, "PENDING_CANCEL", o.symbol, SideFromType(o.type), 0, o.openPrice, o.sl, o.tp,
                  IntegerToString(o.ticket));
  }

//+------------------------------------------------------------------+
//| Open-position snapshot for reconciliation — the "Master state"    |
//| side of the comparison the backend runs periodically.             |
//+------------------------------------------------------------------+
string BuildPositionsJson()
  {
   string result = "[";
   int total = OrdersTotal();

   for(int i = 0; i < total; i++)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
         continue;

      int type = OrderType();
      if(type != OP_BUY && type != OP_SELL)
         continue; // pending orders aren't "positions" for reconciliation

      JsonBuilder pos;
      pos.AddString("ticket", IntegerToString(OrderTicket()));
      pos.AddString("symbol", OrderSymbol());
      pos.AddString("side", type == OP_BUY ? "BUY" : "SELL");
      pos.AddNumber("volume", OrderLots(), 2);
      if(OrderStopLoss() > 0)
         pos.AddNumber("sl", OrderStopLoss(), 5);
      if(OrderTakeProfit() > 0)
         pos.AddNumber("tp", OrderTakeProfit(), 5);

      if(result != "[")
         result += ",";
      result += pos.Build();
     }

   result += "]";
   return result;
  }

//+------------------------------------------------------------------+
//| Timestamp helper                                                 |
//+------------------------------------------------------------------+
string NowIso8601()
  {
   // TimeCurrent() is broker server time, not guaranteed UTC. subtract
   // BrokerGmtOffsetHours so latency numbers computed on the backend are
   // meaningful rather than skewed by a constant broker-timezone offset.
   datetime utcNow = TimeCurrent() - BrokerGmtOffsetHours * 3600;
   MqlDateTime dt;
   TimeToStruct(utcNow, dt);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02d.000Z", dt.year, dt.mon, dt.day, dt.hour, dt.min, dt.sec);
  }

//+------------------------------------------------------------------+
//| Normalization + transmission — identical wire format to the MT5  |
//| EA's SendTradeEvent, so the backend's ingest endpoint needs no    |
//| changes to accept either one.                                     |
//+------------------------------------------------------------------+
void SendTradeEvent(const string eventId, const string type, const string symbol,
                     const string side, const double volume, const double price,
                     const double sl, const double tp, const string masterTicket)
  {
   string detectedTime = NowIso8601();

   JsonBuilder json;
   json.AddString("eventId", eventId);
   json.AddString("masterTicket", masterTicket);
   json.AddString("type", type);
   json.AddString("symbol", symbol);
   if(StringLen(side) > 0)
      json.AddString("side", side);
   if(volume > 0)
      json.AddNumber("volume", volume, 2);
   if(price > 0)
      json.AddNumber("price", price, 5);
   if(sl > 0)
      json.AddNumber("sl", sl, 5);
   if(tp > 0)
      json.AddNumber("tp", tp, 5);
   // Unlike the MT5 EA, detection here is only as fresh as the last scan
   // (up to TimerIntervalMs old), not instantaneous — masterEventTime is
   // stamped as "now" rather than the true moment of the trade, since MT4
   // exposes no such timestamp for a detected change. The gap this adds to
   // the latency dashboard is bounded by TimerIntervalMs, not unbounded.
   json.AddString("masterEventTime", detectedTime);
   json.AddString("eaSentTime", NowIso8601());

   http.SendEvent(eventId, json.Build());
  }
