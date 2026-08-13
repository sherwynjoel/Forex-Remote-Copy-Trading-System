//+------------------------------------------------------------------+
//| Json.mqh                                                         |
//| Minimal JSON object builder — identical to                       |
//| connectors/master-ea/Include/ForexCopy/Json.mqh, copied rather   |
//| than shared since MT4 and MT5 terminals need their own copy on   |
//| disk. Used here for the heartbeat body and execution-result       |
//| payloads (see JsonReader.mqh for the other direction — parsing   |
//| the instruction this EA receives).                                |
//+------------------------------------------------------------------+
#property strict

class JsonBuilder
  {
private:
   string            m_body;
   bool              m_first;

   void              AppendKeyRaw(const string key, const string rawValue)
     {
      if(!m_first)
         m_body += ",";
      m_body += "\"" + key + "\":" + rawValue;
      m_first = false;
     }

   string            EscapeString(const string value)
     {
      string escaped = value;
      StringReplace(escaped, "\\", "\\\\");
      StringReplace(escaped, "\"", "\\\"");
      StringReplace(escaped, "\n", "\\n");
      StringReplace(escaped, "\r", "");
      return escaped;
     }

public:
                     JsonBuilder() { m_body = ""; m_first = true; }

   void              AddString(const string key, const string value)
     {
      AppendKeyRaw(key, "\"" + EscapeString(value) + "\"");
     }

   void              AddNumber(const string key, const double value, const int digits = 5)
     {
      AppendKeyRaw(key, DoubleToString(value, digits));
     }

   void              AddInteger(const string key, const long value)
     {
      AppendKeyRaw(key, IntegerToString(value));
     }

   void              AddBool(const string key, const bool value)
     {
      AppendKeyRaw(key, value ? "true" : "false");
     }

   void              AddRaw(const string key, const string rawJson)
     {
      AppendKeyRaw(key, rawJson);
     }

   string            Build()
     {
      return "{" + m_body + "}";
     }
  };
