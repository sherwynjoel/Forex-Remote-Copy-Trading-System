//+------------------------------------------------------------------+
//| ForexCopyMasterEA.mq5                                            |
//| Master connector for the Forex Remote Copy Trading System.       |
//|                                                                    |
//| Responsibility is deliberately narrow: detect -> normalize ->     |
//| transmit. No volume calculation, no risk checks, no knowledge of  |
//| Slaves — that logic lives in the backend Copy Engine / Risk       |
//| Engine, per the system's layering rule.                          |
//|                                                                    |
//| Detection is driven entirely by OnTradeTransaction(), a native    |
//| MT5 platform callback fired the instant a trade transaction       |
//| occurs — there is no polling anywhere in this file.               |
//+------------------------------------------------------------------+
#property copyright "Forex Remote Copy Trading System"
#property version   "1.00"
#property strict

#include <ForexCopy/Json.mqh>
#include <ForexCopy/Http.mqh>

input string BackendUrl                 = "http://localhost:4000"; // must be allow-listed: Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL
input string ConnectorToken             = "";                      // from POST /api/masters/:id/connectors
input int    HeartbeatIntervalSeconds   = 5;
input int    TimerIntervalSeconds       = 1;                       // drives retry-queue drain + heartbeat cadence
input int    BrokerGmtOffsetHours       = 0;                       // set to your broker server's UTC offset so latency timestamps are accurate

HttpClient http;
// Wall-clock milliseconds (GetTickCount64()), not TimeCurrent() — see
// Http.mqh's RetryItem.nextAttemptAtMs comment for why: TimeCurrent() is
// the symbol's last known tick time, which stalls whenever no new price
// ticks arrive, silently freezing anything scheduled off of it.
ulong      g_lastHeartbeatMs = 0;
long       g_accountLogin  = 0;
int        g_eventSeq      = 0;

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(ConnectorToken) == 0)
     {
      Print("ForexCopy: ConnectorToken input is empty. Register a connector via POST /api/masters/:id/connectors first.");
      return(INIT_PARAMETERS_INCORRECT);
     }

   g_accountLogin = AccountInfoInteger(ACCOUNT_LOGIN);
   http.Init(BackendUrl, ConnectorToken);
   EventSetTimer(TimerIntervalSeconds);
   PrintFormat("ForexCopy Master EA initialized for account %d, backend=%s", g_accountLogin, BackendUrl);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   http.ProcessRetryQueue();

   if(GetTickCount64() - g_lastHeartbeatMs >= (ulong)HeartbeatIntervalSeconds * 1000)
     {
      // Balance/equity/positions ride on the heartbeat since it already
      // flows every few seconds — this is the only source of that data for
      // BALANCE_PROPORTIONAL/EQUITY_PROPORTIONAL volume sizing and for
      // reconciliation's "Master state" (see docs/ARCHITECTURE.md).
      JsonBuilder hb;
      hb.AddNumber("balance", AccountInfoDouble(ACCOUNT_BALANCE), 2);
      hb.AddNumber("equity", AccountInfoDouble(ACCOUNT_EQUITY), 2);
      hb.AddRaw("positions", BuildPositionsJson());
      http.SendHeartbeat(hb.Build());
      g_lastHeartbeatMs = GetTickCount64();
     }
  }

//+------------------------------------------------------------------+
//| Open-position snapshot for reconciliation — the "Master state"    |
//| side of the comparison the backend runs periodically.             |
//+------------------------------------------------------------------+
string BuildPositionsJson()
  {
   string result = "[";
   int total = PositionsTotal();

   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i); // also selects it for the calls below
      if(ticket == 0)
         continue;

      string symbol = PositionGetString(POSITION_SYMBOL);
      double volume = PositionGetDouble(POSITION_VOLUME);
      double sl     = PositionGetDouble(POSITION_SL);
      double tp     = PositionGetDouble(POSITION_TP);
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      string side = (posType == POSITION_TYPE_BUY) ? "BUY" : "SELL";

      JsonBuilder pos;
      pos.AddString("ticket", IntegerToString((long)ticket));
      pos.AddString("symbol", symbol);
      pos.AddString("side", side);
      pos.AddNumber("volume", volume, 2);
      if(sl > 0)
         pos.AddNumber("sl", sl, 5);
      if(tp > 0)
         pos.AddNumber("tp", tp, 5);

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
//| Normalization + transmission                                     |
//+------------------------------------------------------------------+
void SendTradeEvent(const string eventId, const string type, const string symbol,
                     const string side, const double volume, const double price,
                     const double sl, const double tp, const string masterTicket)
  {
   string sentTime = NowIso8601();

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
   // Detection is instant (native event, no polling), so both timestamps are
   // stamped here, back to back — the gap between them measures actual EA
   // processing time, not a polling interval.
   json.AddString("masterEventTime", sentTime);
   json.AddString("eaSentTime", NowIso8601());

   http.SendEvent(eventId, json.Build());
  }

//+------------------------------------------------------------------+
//| DEAL_ADD -> OPEN / CLOSE / PARTIAL_CLOSE                          |
//+------------------------------------------------------------------+
string SideFromDealType(const ENUM_DEAL_TYPE dealType, const ENUM_DEAL_ENTRY entry)
  {
   bool isBuyDeal = (dealType == DEAL_TYPE_BUY);
   if(entry == DEAL_ENTRY_IN)
      return isBuyDeal ? "BUY" : "SELL";
   // Closing deals execute in the opposite direction of the original
   // position, so invert to report the side the Slave should act on.
   return isBuyDeal ? "SELL" : "BUY";
  }

void HandleDealAdd(const ulong dealTicket)
  {
   ENUM_DEAL_TYPE dType = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dealTicket, DEAL_TYPE);
   if(dType != DEAL_TYPE_BUY && dType != DEAL_TYPE_SELL)
      return; // ignore balance/credit/swap/commission deals

   ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
   string symbol   = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
   double volume   = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
   double price    = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
   ulong  positionId = (ulong)HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
   string side     = SideFromDealType(dType, entry);
   string eventId  = "DEAL-" + IntegerToString(g_accountLogin) + "-" + IntegerToString((long)dealTicket);

   if(entry == DEAL_ENTRY_IN)
     {
      double sl = 0, tp = 0;
      if(PositionSelectByTicket(positionId))
        {
         sl = PositionGetDouble(POSITION_SL);
         tp = PositionGetDouble(POSITION_TP);
        }
      SendTradeEvent(eventId, "OPEN", symbol, side, volume, price, sl, tp, IntegerToString((long)positionId));
      return;
     }

   if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
     {
      bool stillOpen = PositionSelectByTicket(positionId);
      string type = stillOpen ? "PARTIAL_CLOSE" : "CLOSE";
      SendTradeEvent(eventId, type, symbol, side, volume, price, 0, 0, IntegerToString((long)positionId));
      return;
     }
   // DEAL_ENTRY_INOUT (position reversal) intentionally not handled in
   // Phase 1 — flagged for Phase 2/3 when the Copy Engine can express it
   // as an atomic close+open pair.
  }

//+------------------------------------------------------------------+
//| ORDER_ADD / ORDER_UPDATE -> PENDING_OPEN / PENDING_MODIFY         |
//+------------------------------------------------------------------+
bool IsPendingOrderType(const ENUM_ORDER_TYPE orderType)
  {
   return orderType == ORDER_TYPE_BUY_LIMIT  || orderType == ORDER_TYPE_SELL_LIMIT ||
          orderType == ORDER_TYPE_BUY_STOP   || orderType == ORDER_TYPE_SELL_STOP  ||
          orderType == ORDER_TYPE_BUY_STOP_LIMIT || orderType == ORDER_TYPE_SELL_STOP_LIMIT;
  }

string SideFromOrderType(const ENUM_ORDER_TYPE orderType)
  {
   switch(orderType)
     {
      case ORDER_TYPE_BUY_LIMIT:
      case ORDER_TYPE_BUY_STOP:
      case ORDER_TYPE_BUY_STOP_LIMIT:
         return "BUY";
      default:
         return "SELL";
     }
  }

void HandleOrderAddOrUpdate(const ulong orderTicket, const string eventType)
  {
   if(!OrderSelect(orderTicket))
      return;

   ENUM_ORDER_TYPE orderType = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
   if(!IsPendingOrderType(orderType))
      return; // market orders resolve into a deal; handled by HandleDealAdd instead

   string symbol = OrderGetString(ORDER_SYMBOL);
   double price  = OrderGetDouble(ORDER_PRICE_OPEN);
   double sl     = OrderGetDouble(ORDER_SL);
   double tp     = OrderGetDouble(ORDER_TP);
   double volume = OrderGetDouble(ORDER_VOLUME_CURRENT);
   string side   = SideFromOrderType(orderType);

   g_eventSeq++;
   string eventId = "ORDER-" + IntegerToString(g_accountLogin) + "-" + IntegerToString((long)orderTicket) +
                     "-" + IntegerToString(g_eventSeq);

   SendTradeEvent(eventId, eventType, symbol, side, volume, price, sl, tp, IntegerToString((long)orderTicket));
  }

//+------------------------------------------------------------------+
//| ORDER_DELETE -> PENDING_CANCEL                                    |
//+------------------------------------------------------------------+
void HandleOrderDelete(const ulong orderTicket)
  {
   string symbol = "";
   string side = "";
   double price = 0, sl = 0, tp = 0;

   if(HistoryOrderSelect(orderTicket))
     {
      symbol = HistoryOrderGetString(orderTicket, ORDER_SYMBOL);
      ENUM_ORDER_TYPE orderType = (ENUM_ORDER_TYPE)HistoryOrderGetInteger(orderTicket, ORDER_TYPE);
      side  = SideFromOrderType(orderType);
      price = HistoryOrderGetDouble(orderTicket, ORDER_PRICE_OPEN);
      sl    = HistoryOrderGetDouble(orderTicket, ORDER_SL);
      tp    = HistoryOrderGetDouble(orderTicket, ORDER_TP);
     }

   // Simplification for Phase 1: every ORDER_DELETE is reported as a
   // cancellation, even when the delete is actually the pending order being
   // triggered into a deal. A DEAL_ADD transaction fires separately for that
   // case, so the backend (Phase 3 Copy Engine) can reconcile a
   // CANCEL-immediately-followed-by-OPEN pair rather than this EA guessing.
   string eventId = "ORDERDEL-" + IntegerToString(g_accountLogin) + "-" + IntegerToString((long)orderTicket);
   SendTradeEvent(eventId, "PENDING_CANCEL", symbol, side, 0, price, sl, tp, IntegerToString((long)orderTicket));
  }

//+------------------------------------------------------------------+
//| POSITION -> MODIFY (SL/TP change on an open position)             |
//+------------------------------------------------------------------+
void HandlePositionModify(const ulong positionTicket)
  {
   if(!PositionSelectByTicket(positionTicket))
      return;

   string symbol = PositionGetString(POSITION_SYMBOL);
   double sl     = PositionGetDouble(POSITION_SL);
   double tp     = PositionGetDouble(POSITION_TP);
   double volume = PositionGetDouble(POSITION_VOLUME);
   ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   string side = (posType == POSITION_TYPE_BUY) ? "BUY" : "SELL";

   g_eventSeq++;
   string eventId = "POS-" + IntegerToString(g_accountLogin) + "-" + IntegerToString((long)positionTicket) +
                     "-" + IntegerToString(g_eventSeq);

   SendTradeEvent(eventId, "MODIFY", symbol, side, volume, 0, sl, tp, IntegerToString((long)positionTicket));
  }

//+------------------------------------------------------------------+
//| The single entry point for all detection. Native MT5 callback,   |
//| fired synchronously the instant a trade transaction occurs.      |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                         const MqlTradeRequest &request,
                         const MqlTradeResult &result)
  {
   switch(trans.type)
     {
      case TRADE_TRANSACTION_DEAL_ADD:
         HandleDealAdd(trans.deal);
         break;
      case TRADE_TRANSACTION_ORDER_ADD:
         HandleOrderAddOrUpdate(trans.order, "PENDING_OPEN");
         break;
      case TRADE_TRANSACTION_ORDER_UPDATE:
         HandleOrderAddOrUpdate(trans.order, "PENDING_MODIFY");
         break;
      case TRADE_TRANSACTION_ORDER_DELETE:
         HandleOrderDelete(trans.order);
         break;
      case TRADE_TRANSACTION_POSITION:
         HandlePositionModify(trans.position);
         break;
      default:
         break; // HISTORY_*, DEAL_UPDATE/DELETE, REQUEST — not needed for Phase 1
     }
  }
//+------------------------------------------------------------------+
