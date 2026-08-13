//+------------------------------------------------------------------+
//| JsonReader.mqh                                                   |
//| Minimal flat-JSON-object reader — the read-side counterpart to    |
//| JsonBuilder. Deliberately not a general-purpose parser: the only  |
//| thing this EA ever reads is a CopyInstruction, a flat object of   |
//| known string/number fields with no nesting, arrays, or escaped    |
//| characters within them (copyId is a UUID, action/symbol/side are  |
//| plain identifiers, volume/sl/tp are plain numbers) — the backend  |
//| controls both sides of this wire format, so that shape is         |
//| guaranteed, not assumed.                                          |
//+------------------------------------------------------------------+
#property strict

class JsonReader
  {
private:
   string            m_body;

   // Locates "key": and returns the raw (still-quoted, for strings)
   // substring of its value.
   bool              FindRawValue(const string key, string &rawOut)
     {
      string needle = "\"" + key + "\":";
      int pos = StringFind(m_body, needle);
      if(pos < 0)
         return false;

      int start = pos + StringLen(needle);
      int len = StringLen(m_body);
      while(start < len && StringGetCharacter(m_body, start) == ' ')
         start++;
      if(start >= len)
         return false;

      ushort ch = StringGetCharacter(m_body, start);
      int end;

      if(ch == '"')
        {
         end = start + 1;
         while(end < len && StringGetCharacter(m_body, end) != '"')
            end++;
         rawOut = StringSubstr(m_body, start, end - start + 1);
         return true;
        }

      // number / true / false / null — runs until the next "," or "}"
      end = start;
      while(end < len)
        {
         ushort c = StringGetCharacter(m_body, end);
         if(c == ',' || c == '}')
            break;
         end++;
        }
      rawOut = StringSubstr(m_body, start, end - start);
      return true;
     }

public:
   void              Init(const string body)
     {
      m_body = body;
     }

   bool              HasKey(const string key)
     {
      string raw;
      return FindRawValue(key, raw);
     }

   string            GetString(const string key, const string defaultValue = "")
     {
      string raw;
      if(!FindRawValue(key, raw))
         return defaultValue;
      if(StringLen(raw) >= 2 && StringGetCharacter(raw, 0) == '"')
         return StringSubstr(raw, 1, StringLen(raw) - 2);
      return raw;
     }

   double            GetDouble(const string key, const double defaultValue = 0)
     {
      string raw;
      if(!FindRawValue(key, raw))
         return defaultValue;
      return StringToDouble(raw);
     }
  };
