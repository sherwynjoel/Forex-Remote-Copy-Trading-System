//+------------------------------------------------------------------+
//| Json.mqh                                                         |
//| Minimal JSON object builder for the fixed trade-event schema.    |
//| Deliberately not a general-purpose JSON library: the EA's job is |
//| detect -> normalize -> transmit, nothing more, so this only      |
//| knows how to build flat objects of string/number/bool fields.    |
//|                                                                    |
//| Identical to connectors/master-ea/Include/ForexCopy/Json.mqh —   |
//| nothing here is MT5-specific, so this is a straight copy.        |
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

   // Adds a key whose value is already a JSON-encoded literal (e.g. null,
   // or a value produced by another JsonBuilder), without re-quoting it.
   void              AddRaw(const string key, const string rawJson)
     {
      AppendKeyRaw(key, rawJson);
     }

   string            Build()
     {
      return "{" + m_body + "}";
     }
  };
