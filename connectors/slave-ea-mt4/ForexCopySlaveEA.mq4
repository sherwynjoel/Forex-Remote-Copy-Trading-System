//+------------------------------------------------------------------+
//| ForexCopySlaveEA.mq4                                             |
//| Slave connector for the Forex Remote Copy Trading System — MT4   |
//| variant.                                                          |
//|                                                                    |
//| MQL4 has no equivalent to MetaTrader5's official Python IPC       |
//| package, and WebRequest() is outbound-only on both platforms —   |
//| this EA can never be pushed to. It polls instead: ask the backend |
//| "anything pending for me?" on a short timer, execute what it      |
//| gets back, report the result. Same message shapes as the Python   |
//| slave-service (backend/src/types/copyOrder.ts) — the backend      |
//| picks HTTP polling vs. WebSocket push per-Slave by platform, and  |
//| neither side of the Copy Engine needed to change for this to      |
//| exist alongside it.                                                |
//|                                                                    |
//| Contains no risk/volume logic — the backend already decided       |
//| *what* to send by the time this EA ever sees it; this only        |
//| executes it and reports back what actually happened.              |
//+------------------------------------------------------------------+
#property copyright "Forex Remote Copy Trading System"
#property version   "1.00"
#property strict

#include <stdlib.mqh>
#include <ForexCopy/Json.mqh>
#include <ForexCopy/JsonReader.mqh>
#include <ForexCopy/SlaveHttp.mqh>

input string BackendUrl               = "http://localhost:4000"; // must be allow-listed: Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL
input string ConnectorToken           = "";                      // from POST /api/slaves/:id/connectors
input int    PollIntervalMs           = 500;                     // how often to ask "anything pending?" — the real "how fast do we copy" number on MT4
input int    HeartbeatIntervalSeconds = 5;
input int    SlippagePoints           = 20;
input int    MagicNumber              = 0;

SlaveHttpClient http;
// Wall-clock milliseconds (GetTickCount64()), not TimeCurrent() — the
// latter is the symbol's last known tick time, which stalls whenever no
// new price ticks arrive, silently freezing anything scheduled off it.
ulong           g_lastHeartbeatMs = 0;

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(ConnectorToken) == 0)
     {
      Print("ForexCopy: ConnectorToken input is empty. Register a connector via POST /api/slaves/:id/connectors first.");
      return(INIT_PARAMETERS_INCORRECT);
     }

   http.Init(BackendUrl, ConnectorToken);
   EventSetMillisecondTimer(PollIntervalMs);
   PrintFormat("ForexCopy Slave EA (MT4) initialized, backend=%s, poll interval=%dms", BackendUrl, PollIntervalMs);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   http.ProcessRetryQueue();
   PollForInstruction();

   if(GetTickCount64() - g_lastHeartbeatMs >= (ulong)HeartbeatIntervalSeconds * 1000)
     {
      SendHeartbeatNow();
      g_lastHeartbeatMs = GetTickCount64();
     }
  }

//+------------------------------------------------------------------+
//| Poll -> execute -> report                                        |
//+------------------------------------------------------------------+
void PollForInstruction()
  {
   string response;
   int status = http.Get("/api/connectors/pending-instruction", response);

   if(status == 401)
     {
      Print("ForexCopy: pending-instruction poll unauthorized (401) — check ConnectorToken");
      return;
     }
   if(status != 200)
      return; // 204 = nothing pending; -1/other = transient, next poll retries

   JsonReader reader;
   reader.Init(response);

   string copyId = reader.GetString("copyId");
   string action = reader.GetString("action");
   if(StringLen(copyId) == 0 || StringLen(action) == 0)
     {
      Print("ForexCopy: malformed instruction body, ignoring: ", response);
      return;
     }

   string resultJson;
   if(action == "OPEN")
     {
      string symbol = reader.GetString("symbol");
      string side   = reader.GetString("side");
      double volume = reader.GetDouble("volume");
      double sl     = reader.GetDouble("sl");
      double tp     = reader.GetDouble("tp");
      resultJson = ExecuteOpen(copyId, symbol, side, volume, sl, tp);
     }
   else if(action == "CLOSE")
     {
      resultJson = ExecuteClose(copyId, reader.GetString("slaveTicket"));
     }
   else if(action == "MODIFY")
     {
      double sl = reader.GetDouble("sl");
      double tp = reader.GetDouble("tp");
      resultJson = ExecuteModify(copyId, reader.GetString("slaveTicket"), sl, tp);
     }
   else
     {
      resultJson = FailureResult(copyId, "unsupported action: " + action);
     }

   PrintFormat("ForexCopy: copy %s (%s) -> %s", copyId, action, resultJson);
   http.SendExecutionResult(resultJson);
  }

//+------------------------------------------------------------------+
//| Execution — mirrors connectors/slave-service/main.py exactly:    |
//| OPEN sizes/prices at current market, CLOSE always closes the      |
//| Slave's existing full position regardless of the instruction's   |
//| own volume field, MODIFY only ever touches SL/TP.                 |
//+------------------------------------------------------------------+
string ExecuteOpen(const string copyId, const string symbol, const string side, const double volume,
                    const double sl, const double tp)
  {
   if(!SymbolSelect(symbol, true))
      return FailureResult(copyId, "symbol not available: " + symbol);

   double price = (side == "BUY") ? MarketInfo(symbol, MODE_ASK) : MarketInfo(symbol, MODE_BID);
   if(price <= 0)
      return FailureResult(copyId, "no price for symbol: " + symbol);

   int cmd = (side == "BUY") ? OP_BUY : OP_SELL;
   int ticket = OrderSend(symbol, cmd, volume, price, SlippagePoints, sl, tp,
                           "copy:" + copyId, MagicNumber, 0, clrNONE);

   if(ticket < 0)
      return FailureResult(copyId, "OrderSend failed: " + ErrorDescription(GetLastError()));

   double execPrice = price;
   if(OrderSelect(ticket, SELECT_BY_TICKET))
      execPrice = OrderOpenPrice();

   return SuccessResult(copyId, IntegerToString(ticket), execPrice);
  }

string ExecuteClose(const string copyId, const string slaveTicketStr)
  {
   if(StringLen(slaveTicketStr) == 0)
      return FailureResult(copyId, "no slaveTicket provided for CLOSE");

   int ticket = (int)StringToInteger(slaveTicketStr);
   if(!OrderSelect(ticket, SELECT_BY_TICKET))
      return FailureResult(copyId, "no open position for ticket " + slaveTicketStr);

   string symbol = OrderSymbol();
   double lots   = OrderLots();
   int    type   = OrderType();
   double price  = (type == OP_BUY) ? MarketInfo(symbol, MODE_BID) : MarketInfo(symbol, MODE_ASK);

   if(!OrderClose(ticket, lots, price, SlippagePoints, clrNONE))
      return FailureResult(copyId, "OrderClose failed: " + ErrorDescription(GetLastError()));

   double execPrice = price;
   if(OrderSelect(ticket, SELECT_BY_TICKET) && OrderCloseTime() > 0)
      execPrice = OrderClosePrice();

   return SuccessResult(copyId, IntegerToString(ticket), execPrice);
  }

string ExecuteModify(const string copyId, const string slaveTicketStr, const double sl, const double tp)
  {
   if(StringLen(slaveTicketStr) == 0)
      return FailureResult(copyId, "no slaveTicket provided for MODIFY");

   int ticket = (int)StringToInteger(slaveTicketStr);
   if(!OrderSelect(ticket, SELECT_BY_TICKET))
      return FailureResult(copyId, "no open position for ticket " + slaveTicketStr);

   if(!OrderModify(ticket, OrderOpenPrice(), sl, tp, 0, clrNONE))
      return FailureResult(copyId, "OrderModify failed: " + ErrorDescription(GetLastError()));

   return SuccessResult(copyId, IntegerToString(ticket), 0);
  }

string SuccessResult(const string copyId, const string slaveTicket, const double executionPrice)
  {
   JsonBuilder json;
   json.AddString("copyId", copyId);
   json.AddString("status", "EXECUTED");
   json.AddString("slaveTicket", slaveTicket);
   if(executionPrice > 0)
      json.AddNumber("executionPrice", executionPrice, 5);
   return json.Build();
  }

string FailureResult(const string copyId, const string reason)
  {
   Print("ForexCopy: copy ", copyId, " failed: ", reason);
   JsonBuilder json;
   json.AddString("copyId", copyId);
   json.AddString("status", "FAILED");
   json.AddString("reason", reason);
   return json.Build();
  }

//+------------------------------------------------------------------+
//| Heartbeat — reuses the same POST /api/connectors/heartbeat both  |
//| the Master EA and the MT5 Slave service already use. Positions    |
//| carry `comment` (the "copy:<copyId>" tag set in ExecuteOpen), the |
//| "Slave state" side of reconciliation — see                        |
//| docs/ARCHITECTURE.md.                                             |
//+------------------------------------------------------------------+
void SendHeartbeatNow()
  {
   JsonBuilder hb;
   hb.AddNumber("balance", AccountBalance(), 2);
   hb.AddNumber("equity", AccountEquity(), 2);
   hb.AddRaw("positions", BuildPositionsJson());
   http.SendHeartbeat(hb.Build());
  }

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
      string comment = OrderComment();
      if(StringLen(comment) > 0)
         pos.AddString("comment", comment);

      if(result != "[")
         result += ",";
      result += pos.Build();
     }

   result += "]";
   return result;
  }
