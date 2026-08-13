//+------------------------------------------------------------------+
//| SlaveHttp.mqh                                                    |
//| Generic WebRequest() GET/POST wrapper for the Slave EA, plus a    |
//| small retry queue specifically for execution-result POSTs — a    |
//| lost result would otherwise leave a copy_order stuck at SENT      |
//| forever despite the trade having actually executed on this        |
//| terminal. Polling for new work needs no such queue: a failed poll |
//| just tries again at the next timer tick with nothing lost, since  |
//| the backend never marks a copy_order SENT until it has actually   |
//| handed the instruction back in a 200 response.                    |
//+------------------------------------------------------------------+
#property strict

#define FST_MAX_RETRY_QUEUE  100
#define FST_MAX_ATTEMPTS     8
#define FST_TIMEOUT_MS       3000

struct ResultRetryItem
  {
   string            jsonBody;
   int               attempts;
   // Wall-clock milliseconds (GetTickCount64()), not TimeCurrent() — the
   // latter is the symbol's last known tick time, which stalls whenever no
   // new price ticks arrive, silently freezing anything scheduled off it.
   ulong             nextAttemptAtMs;
  };

class SlaveHttpClient
  {
private:
   string            m_baseUrl;
   string            m_token;
   ResultRetryItem   m_queue[];

   string            AuthHeader()
     {
      return "Content-Type: application/json\r\nAuthorization: Bearer " + m_token + "\r\n";
     }

   void              Enqueue(const string jsonBody)
     {
      int size = ArraySize(m_queue);
      if(size >= FST_MAX_RETRY_QUEUE)
        {
         for(int i = 0; i < size - 1; i++)
            m_queue[i] = m_queue[i + 1];
         ArrayResize(m_queue, size - 1);
         size--;
        }
      ArrayResize(m_queue, size + 1);
      m_queue[size].jsonBody = jsonBody;
      m_queue[size].attempts = 1;
      m_queue[size].nextAttemptAtMs = GetTickCount64() + 2000;
     }

public:
   void              Init(const string baseUrl, const string token)
     {
      m_baseUrl = baseUrl;
      m_token = token;
      ArrayResize(m_queue, 0);
     }

   // Status code, or -1 on transport failure. responseOut carries the body.
   int               Get(const string path, string &responseOut)
     {
      uchar data[];
      uchar result[];
      string resultHeaders;

      ResetLastError();
      int status = WebRequest("GET", m_baseUrl + path, AuthHeader(), FST_TIMEOUT_MS, data, result, resultHeaders);
      if(status == -1)
        {
         PrintFormat("ForexCopy: WebRequest GET failed (error %d). Is %s allow-listed under Tools->Options->Expert Advisors?",
                     GetLastError(), m_baseUrl);
         return -1;
        }
      responseOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return status;
     }

   int               Post(const string path, const string jsonBody, string &responseOut)
     {
      uchar data[];
      uchar result[];
      string resultHeaders;

      int bodyLen = StringToCharArray(jsonBody, data, 0, WHOLE_ARRAY, CP_UTF8) - 1;
      ArrayResize(data, MathMax(bodyLen, 0));

      ResetLastError();
      int status = WebRequest("POST", m_baseUrl + path, AuthHeader(), FST_TIMEOUT_MS, data, result, resultHeaders);
      if(status == -1)
        {
         PrintFormat("ForexCopy: WebRequest POST failed (error %d). Is %s allow-listed under Tools->Options->Expert Advisors?",
                     GetLastError(), m_baseUrl);
         return -1;
        }
      responseOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return status;
     }

   void              SendHeartbeat(const string jsonBody)
     {
      string response;
      Post("/api/connectors/heartbeat", jsonBody, response);
     }

   // Posts an execution result; queues it for retry on failure so a
   // completed trade's outcome is never silently lost, only delayed.
   bool              SendExecutionResult(const string jsonBody)
     {
      string response;
      int status = Post("/api/connectors/execution-result", jsonBody, response);
      if(status == 200)
         return true;

      PrintFormat("ForexCopy: execution-result POST failed (status %d), queuing for retry", status);
      Enqueue(jsonBody);
      return false;
     }

   // Called from OnTimer(). Backoff is attempts*2 seconds, capped at 60s —
   // identical shape to the Master EA's retry queue.
   void              ProcessRetryQueue()
     {
      ulong now = GetTickCount64();
      int size = ArraySize(m_queue);

      for(int i = size - 1; i >= 0; i--)
        {
         if(m_queue[i].nextAttemptAtMs > now)
            continue;

         string response;
         int status = Post("/api/connectors/execution-result", m_queue[i].jsonBody, response);

         if(status == 200)
           {
            for(int j = i; j < size - 1; j++)
               m_queue[j] = m_queue[j + 1];
            ArrayResize(m_queue, size - 1);
            size--;
            continue;
           }

         m_queue[i].attempts++;
         if(m_queue[i].attempts > FST_MAX_ATTEMPTS)
           {
            PrintFormat("ForexCopy: giving up on an execution-result after %d attempts", m_queue[i].attempts);
            for(int j = i; j < size - 1; j++)
               m_queue[j] = m_queue[j + 1];
            ArrayResize(m_queue, size - 1);
            size--;
            continue;
           }

         ulong backoffMs = (ulong)MathMin(m_queue[i].attempts * 2, 60) * 1000;
         m_queue[i].nextAttemptAtMs = now + backoffMs;
        }
     }

   int               PendingCount()
     {
      return ArraySize(m_queue);
     }
  };
