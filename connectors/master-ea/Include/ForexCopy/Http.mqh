//+------------------------------------------------------------------+
//| Http.mqh                                                         |
//| Thin WebRequest() wrapper + a bounded in-memory retry queue for   |
//| events that fail to send (backend down, network blip). No DLLs   |
//| required — the backend URL just needs to be allow-listed under   |
//| Tools -> Options -> Expert Advisors in the terminal.              |
//+------------------------------------------------------------------+
#property strict

#define FCT_MAX_RETRY_QUEUE   200   // bounded so a long outage can't leak memory
#define FCT_MAX_ATTEMPTS      8     // after this many failed retries, drop + log
#define FCT_TIMEOUT_MS        3000

struct RetryItem
  {
   string            eventId;
   string            jsonBody;
   int               attempts;
   datetime          nextAttemptAt;
  };

class HttpClient
  {
private:
   string            m_baseUrl;
   string            m_token;
   RetryItem         m_queue[];

   string            AuthHeader()
     {
      return "Content-Type: application/json\r\nAuthorization: Bearer " + m_token + "\r\n";
     }

   // Returns HTTP status code, or -1 on transport-level failure (e.g. URL not
   // allow-listed, no connectivity). Does not touch the retry queue itself.
   int               Post(const string path, const string jsonBody, string &responseOut)
     {
      uchar data[];
      uchar result[];
      string resultHeaders;

      int bodyLen = StringToCharArray(jsonBody, data, 0, WHOLE_ARRAY, CP_UTF8) - 1;
      ArrayResize(data, MathMax(bodyLen, 0));

      ResetLastError();
      int status = WebRequest("POST", m_baseUrl + path, AuthHeader(), FCT_TIMEOUT_MS, data, result, resultHeaders);

      if(status == -1)
        {
         PrintFormat("ForexCopy: WebRequest failed (error %d). Is %s allow-listed under Tools->Options->Expert Advisors?",
                     GetLastError(), m_baseUrl);
         return -1;
        }

      responseOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return status;
     }

   void              Enqueue(const string eventId, const string jsonBody)
     {
      int size = ArraySize(m_queue);
      if(size >= FCT_MAX_RETRY_QUEUE)
        {
         PrintFormat("ForexCopy: retry queue full (%d), dropping oldest event %s", size, m_queue[0].eventId);
         for(int i = 0; i < size - 1; i++)
            m_queue[i] = m_queue[i + 1];
         ArrayResize(m_queue, size - 1);
         size--;
        }

      ArrayResize(m_queue, size + 1);
      m_queue[size].eventId = eventId;
      m_queue[size].jsonBody = jsonBody;
      m_queue[size].attempts = 1;
      m_queue[size].nextAttemptAt = TimeCurrent() + 2;
     }

public:
   void              Init(const string baseUrl, const string token)
     {
      m_baseUrl = baseUrl;
      m_token = token;
      ArrayResize(m_queue, 0);
     }

   // Called immediately from OnTradeTransaction. On failure, the event is
   // queued for OnTimer() to retry, so a transient outage never silently
   // drops a trade.
   bool              SendEvent(const string eventId, const string jsonBody)
     {
      string response;
      int status = Post("/api/ingest/trade-event", jsonBody, response);

      if(status == 200 || status == 202)
         return true;

      PrintFormat("ForexCopy: send failed for event %s (status %d), queuing for retry", eventId, status);
      Enqueue(eventId, jsonBody);
      return false;
     }

   void              SendHeartbeat()
     {
      string response;
      Post("/api/connectors/heartbeat", "{}", response);
     }

   // Called from OnTimer(). Backoff is attempts*2 seconds, capped at 60s.
   void              ProcessRetryQueue()
     {
      datetime now = TimeCurrent();
      int size = ArraySize(m_queue);

      for(int i = size - 1; i >= 0; i--)
        {
         if(m_queue[i].nextAttemptAt > now)
            continue;

         string response;
         int status = Post("/api/ingest/trade-event", m_queue[i].jsonBody, response);

         if(status == 200 || status == 202)
           {
            for(int j = i; j < size - 1; j++)
               m_queue[j] = m_queue[j + 1];
            ArrayResize(m_queue, size - 1);
            size--;
            continue;
           }

         m_queue[i].attempts++;
         if(m_queue[i].attempts > FCT_MAX_ATTEMPTS)
           {
            PrintFormat("ForexCopy: giving up on event %s after %d attempts", m_queue[i].eventId, m_queue[i].attempts);
            for(int j = i; j < size - 1; j++)
               m_queue[j] = m_queue[j + 1];
            ArrayResize(m_queue, size - 1);
            size--;
            continue;
           }

         int backoffSeconds = (int)MathMin(m_queue[i].attempts * 2, 60);
         m_queue[i].nextAttemptAt = now + backoffSeconds;
        }
     }

   int               PendingCount()
     {
      return ArraySize(m_queue);
     }
  };
