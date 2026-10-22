//+------------------------------------------------------------------+
//|                                                 PAR_Radar_EA.mq5 |
//|  Opera os sinais do indicador Price Action Radar lendo as caixas  |
//|  que ele desenha no gráfico (verde = compra, rosa = venda).       |
//|  Alternativa: detecção própria de Engolfo/Pin Bar (backtestável). |
//+------------------------------------------------------------------+
#property copyright "MANUAL"
#property version   "1.00"
#property description "EA que lê as caixas de padrão do Price Action Radar no mesmo gráfico."

#include <Trade\Trade.mqh>

enum ENUM_SIGNAL_SOURCE
  {
   SRC_RADAR_OBJECTS = 0, // Caixas do Price Action Radar
   SRC_NATIVE        = 1  // Detecção própria (Engolfo / Pin Bar)
  };

enum ENUM_LOT_MODE
  {
   LOT_FIXED        = 0, // Lote fixo
   LOT_RISK_PERCENT = 1  // % do saldo arriscado no stop
  };

enum ENUM_SS_MODE
  {
   SS_OFF             = 0, // Sem filtro de força
   SS_PANEL           = 1, // Ler o painel Smart Strength do gráfico
   SS_NATIVE          = 2, // Força calculada no EA (aproximação, backtestável)
   SS_PANEL_OR_NATIVE = 3  // Painel; se não achar, cálculo próprio
  };

input group "=== Fonte do sinal ==="
input ENUM_SIGNAL_SOURCE InpSource        = SRC_RADAR_OBJECTS;
input ENUM_TIMEFRAMES    InpSignalTF      = PERIOD_M30;
input color              InpBullBoxColor  = C'34,170,129'; // = PatternBoxBullColor do Radar
input color              InpBearBoxColor  = clrDeepPink;   // = PatternBoxBearColor do Radar
input bool               InpRequireDash   = true;          // exige estilo tracejado (PatternBoxStyle = Dash)
input string             InpNameContains  = "";            // filtro opcional pelo nome do objeto
input int                InpMaxBoxAgeBars = 2;             // caixa vale se terminar até N barras atrás
input bool               InpOnlyClosedBar = true;          // ignora caixa que inclui a barra em formação
input int                InpScanSeconds   = 5;             // intervalo de leitura do gráfico
input bool               InpDiagnostic    = true;          // imprime os objetos no log (aba Experts)

input group "=== Padrões nativos (SRC_NATIVE) ==="
input bool   InpNativeEngulfing = true;
input bool   InpNativePinBar    = true;
input double InpPinWickRatio    = 2.0; // pavio mínimo = N x corpo

input group "=== Filtro Smart Strength (só opera a favor) ==="
input ENUM_SS_MODE    InpSSMode         = SS_PANEL;
input double          InpSSMinScore     = 0.0;   // painel: compra exige score > X, venda exige score < -X
input bool            InpSSUseBracket   = true;  // exige [BUY]/[SELL] coerente quando o painel mostrar
input string          InpSSNameContains = "";    // filtro opcional pelo nome dos objetos do painel
input int             InpSSRowTolerance = 4;     // px para considerar dois textos na mesma linha
input ENUM_TIMEFRAMES InpSSTF           = PERIOD_M30; // modo nativo
input int             InpSSNativeBars   = 24;    // modo nativo: barras da variação
input double          InpSSNativeMin    = 0.0;   // modo nativo: diferença mínima de força (%)

input group "=== Filtros ==="
input int  InpMaxSpreadPoints  = 30; // 0 = sem filtro
input int  InpStartHour        = 0;  // hora do servidor
input int  InpEndHour          = 24;
input bool InpOnlyOnePosition  = true;
input bool InpCloseOnOpposite  = true;

input group "=== Gestão ==="
input ENUM_LOT_MODE InpLotMode        = LOT_RISK_PERCENT;
input double        InpFixedLot       = 0.01;
input double        InpRiskPercent    = 1.0;  // % do saldo perdido se o stop for atingido
input int           InpSLBufferPoints = 20;   // stop além da caixa
input double        InpRR             = 2.0;  // alvo = N x risco (0 = sem TP)
input int           InpMinSLPoints    = 50;
input int           InpMaxSLPoints    = 1500; // 0 = sem limite
input int           InpSlippagePoints = 10;

input group "=== Breakeven ==="
input bool   InpUseBreakeven   = true;
input double InpBETriggerR     = 1.0; // move o stop para a entrada quando o lucro atingir N x o risco
input int    InpBEOffsetPoints = 0;   // pontos além da entrada (ex.: cobrir comissão)

input group "=== Trailing stop (após o breakeven) ==="
input bool   InpUseTrailing     = true;
input double InpTrailR          = 1.0; // distância do stop ao preço, em múltiplos do risco inicial
input int    InpTrailStepPoints = 10;  // só move o stop se avançar pelo menos isso
input ulong         InpMagic          = 20261020;

struct Signal
  {
   int      dir;    // 1 compra, -1 venda, 0 nenhum
   double   hi;
   double   lo;
   datetime time;   // início do padrão, usado para não repetir o sinal
   string   origin;
  };

struct TextObj
  {
   string text;  // em maiúsculas
   long   x;
   long   y;
  };

CTrade   trade;
string   g_gvKey;
int      g_lastRectCount = -1;
datetime g_lastNativeBar = 0;
datetime g_lastSSLog     = 0;
string   g_ccy[8] = {"USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"};

//+------------------------------------------------------------------+
int OnInit()
  {
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   // Último sinal tratado fica em variável global do terminal para sobreviver a reinícios.
   g_gvKey = StringFormat("PAR_%s_%I64u", _Symbol, InpMagic);
   if(!GlobalVariableCheck(g_gvKey))
      GlobalVariableSet(g_gvKey, 0);
   CleanRiskVars();

   if(InpSource == SRC_RADAR_OBJECTS && InpDiagnostic)
      DumpObjects(true);

   EventSetTimer(MathMax(1, InpScanSeconds));
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer()                  { ManageStops(); Process(); }
void OnTick()                   { ManageStops(); Process(); }

//+------------------------------------------------------------------+
//| Gestão do stop:                                                    |
//| 1) Breakeven: leva o stop para a entrada quando o lucro alcança    |
//|    InpBETriggerR vezes o risco inicial.                           |
//| 2) Trailing: com o stop já na entrada ou em lucro, acompanha o     |
//|    preço a InpTrailR vezes o risco inicial.                       |
//| O risco inicial fica salvo por ticket (PAR_R_<ticket>) porque,     |
//| depois do breakeven, o stop original deixa de existir.             |
//+------------------------------------------------------------------+
void ManageStops()
  {
   if(!InpUseBreakeven && !InpUseTrailing)
      return;
   double minDist = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || PositionGetString(POSITION_SYMBOL) != _Symbol ||
         (ulong)PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;

      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl   = PositionGetDouble(POSITION_SL);
      double tp   = PositionGetDouble(POSITION_TP);
      if(sl <= 0)
         continue;
      bool   buy   = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double price = buy ? SymbolInfoDouble(_Symbol, SYMBOL_BID) : SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double gain  = buy ? price - open : open - price;
      double risk  = buy ? open - sl : sl - open;
      string rKey  = StringFormat("PAR_R_%I64u", ticket);
      double newSL = 0;
      string what  = "";

      if(risk > 0)
        {
         if(!GlobalVariableCheck(rKey))
            GlobalVariableSet(rKey, risk);
         if(!InpUseBreakeven || gain < InpBETriggerR * risk)
            continue;
         newSL = NormalizeDouble(buy ? open + InpBEOffsetPoints * _Point
                                     : open - InpBEOffsetPoints * _Point, _Digits);
         if(buy ? (newSL <= sl) : (newSL >= sl))
            continue;
         what = "Breakeven";
        }
      else
        {
         if(!InpUseTrailing)
            continue;
         double r0 = 0;
         if(GlobalVariableCheck(rKey))
            r0 = GlobalVariableGet(rKey);
         else if(tp > 0 && InpRR > 0)
            r0 = MathAbs(tp - open) / InpRR; // reserva: risco deduzido do alvo
         if(r0 <= 0)
            continue;
         newSL = NormalizeDouble(buy ? price - InpTrailR * r0 : price + InpTrailR * r0, _Digits);
         if(buy ? (newSL < sl + InpTrailStepPoints * _Point) : (newSL > sl - InpTrailStepPoints * _Point))
            continue;
         what = "Trailing";
        }

      if(buy ? (price - newSL < minDist) : (newSL - price < minDist))
         continue;
      if(trade.PositionModify(ticket, newSL, tp))
         PrintFormat("[PAR] %s: posição %I64u com stop em %s.", what, ticket, DoubleToString(newSL, _Digits));
      else
         PrintFormat("[PAR] %s falhou na posição %I64u (retcode %u).", what, ticket, trade.ResultRetcode());
     }
  }

// Remove o risco salvo de posições que já foram encerradas.
void CleanRiskVars()
  {
   for(int i = GlobalVariablesTotal() - 1; i >= 0; i--)
     {
      string name = GlobalVariableName(i);
      if(StringFind(name, "PAR_R_") != 0)
         continue;
      ulong ticket = (ulong)StringToInteger(StringSubstr(name, 6));
      if(!PositionSelectByTicket(ticket))
         GlobalVariableDel(name);
     }
  }

//+------------------------------------------------------------------+
void Process()
  {
   Signal s;
   bool found = (InpSource == SRC_RADAR_OBJECTS) ? FindRadarSignal(s) : FindNativeSignal(s);
   if(!found)
      return;
   if((double)s.time <= GlobalVariableGet(g_gvKey))
      return;
   if(!PassFilters())
      return; // no modo Radar o sinal segue válido e é reavaliado na próxima leitura
   if(!StrengthAllows(s))
      return; // idem: se a força virar a favor enquanto a caixa vale, entra

   Execute(s);
   GlobalVariableSet(g_gvKey, (double)s.time);
  }

//+------------------------------------------------------------------+
//| Procura a caixa mais recente do Radar com a cor de compra/venda.  |
//+------------------------------------------------------------------+
bool FindRadarSignal(Signal &s)
  {
   s.dir = 0;
   int total = ObjectsTotal(0, 0, OBJ_RECTANGLE);
   if(InpDiagnostic && total != g_lastRectCount)
     {
      if(g_lastRectCount >= 0)
         DumpObjects(false);
      g_lastRectCount = total;
     }

   datetime barNow = iTime(_Symbol, InpSignalTF, 0);
   datetime oldest = iTime(_Symbol, InpSignalTF, InpMaxBoxAgeBars);
   // O painel de mini-candles do Radar é desenhado à direita do preço; isso o exclui.
   datetime future = TimeCurrent() + PeriodSeconds(InpSignalTF);
   datetime best   = 0;

   for(int i = 0; i < total; i++)
     {
      string name = ObjectName(0, i, 0, OBJ_RECTANGLE);
      if(InpNameContains != "" && StringFind(name, InpNameContains) < 0)
         continue;

      long clr = ObjectGetInteger(0, name, OBJPROP_COLOR);
      int  dir = 0;
      if(clr == (long)InpBullBoxColor)
         dir = 1;
      else if(clr == (long)InpBearBoxColor)
         dir = -1;
      else
         continue;

      if(InpRequireDash && ObjectGetInteger(0, name, OBJPROP_STYLE) != STYLE_DASH)
         continue;

      datetime t1     = (datetime)ObjectGetInteger(0, name, OBJPROP_TIME, 0);
      datetime t2     = (datetime)ObjectGetInteger(0, name, OBJPROP_TIME, 1);
      datetime tStart = (t1 < t2) ? t1 : t2;
      datetime tEnd   = (t1 < t2) ? t2 : t1;

      if(tEnd > future || tEnd < oldest)
         continue;
      if(InpOnlyClosedBar && tEnd >= barNow)
         continue;
      if(tStart <= best)
         continue;

      double p1 = ObjectGetDouble(0, name, OBJPROP_PRICE, 0);
      double p2 = ObjectGetDouble(0, name, OBJPROP_PRICE, 1);
      best     = tStart;
      s.dir    = dir;
      s.hi     = MathMax(p1, p2);
      s.lo     = MathMin(p1, p2);
      s.time   = tStart;
      s.origin = name;
     }
   return(s.dir != 0);
  }

//+------------------------------------------------------------------+
//| Engolfo e Pin Bar calculados no próprio EA, só em barra fechada.  |
//+------------------------------------------------------------------+
bool FindNativeSignal(Signal &s)
  {
   s.dir = 0;
   datetime bar = iTime(_Symbol, InpSignalTF, 0);
   if(bar == 0 || bar == g_lastNativeBar)
      return(false);
   g_lastNativeBar = bar;

   double o1 = iOpen(_Symbol, InpSignalTF, 1), c1 = iClose(_Symbol, InpSignalTF, 1);
   double h1 = iHigh(_Symbol, InpSignalTF, 1), l1 = iLow(_Symbol, InpSignalTF, 1);
   double o2 = iOpen(_Symbol, InpSignalTF, 2), c2 = iClose(_Symbol, InpSignalTF, 2);
   double h2 = iHigh(_Symbol, InpSignalTF, 2), l2 = iLow(_Symbol, InpSignalTF, 2);

   if(InpNativeEngulfing)
     {
      int dir = 0;
      if(c2 < o2 && c1 > o1 && c1 >= o2 && o1 <= c2)
         dir = 1;
      else if(c2 > o2 && c1 < o1 && c1 <= o2 && o1 >= c2)
         dir = -1;
      if(dir != 0)
        {
         s.dir    = dir;
         s.hi     = MathMax(h1, h2);
         s.lo     = MathMin(l1, l2);
         s.time   = iTime(_Symbol, InpSignalTF, 2);
         s.origin = "ENG nativo";
         return(true);
        }
     }

   if(InpNativePinBar)
     {
      double range = h1 - l1;
      double body  = MathMax(MathAbs(c1 - o1), _Point);
      double upper = h1 - MathMax(o1, c1);
      double lower = MathMin(o1, c1) - l1;
      int    dir   = 0;
      if(range > 0 && lower >= InpPinWickRatio * body && lower >= 0.6 * range)
         dir = 1;
      else if(range > 0 && upper >= InpPinWickRatio * body && upper >= 0.6 * range)
         dir = -1;
      if(dir != 0)
        {
         s.dir    = dir;
         s.hi     = h1;
         s.lo     = l1;
         s.time   = iTime(_Symbol, InpSignalTF, 1);
         s.origin = "PIN nativo";
         return(true);
        }
     }
   return(false);
  }

//+------------------------------------------------------------------+
bool PassFilters()
  {
   if(InpMaxSpreadPoints > 0 && SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) > InpMaxSpreadPoints)
      return(false);

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(InpStartHour < InpEndHour)
     {
      if(dt.hour < InpStartHour || dt.hour >= InpEndHour)
         return(false);
     }
   else if(InpStartHour > InpEndHour) // janela que atravessa a meia-noite
     {
      if(dt.hour < InpStartHour && dt.hour >= InpEndHour)
         return(false);
     }
   return(true);
  }

//+------------------------------------------------------------------+
//| Filtro Smart Strength: libera só sinal a favor da força do par.   |
//| Sem leitura válida, bloqueia (falha fechada).                     |
//+------------------------------------------------------------------+
bool StrengthAllows(const Signal &s)
  {
   if(InpSSMode == SS_OFF)
      return(true);

   double score   = 0;
   int    bracket = 0;
   string how     = "";
   bool   allowed = false;
   bool   read    = false;

   if(InpSSMode == SS_PANEL || InpSSMode == SS_PANEL_OR_NATIVE)
     {
      read = PanelPairScore(score, bracket, how);
      if(read)
        {
         allowed = (s.dir * score > InpSSMinScore);
         if(InpSSUseBracket && bracket != 0 && bracket != s.dir)
            allowed = false;
        }
     }
   if(!read && (InpSSMode == SS_NATIVE || InpSSMode == SS_PANEL_OR_NATIVE))
     {
      read = NativePairScore(score);
      how  = "cálculo próprio";
      if(read)
         allowed = (s.dir * score > InpSSNativeMin);
     }

   if(!allowed && s.time != g_lastSSLog)
     {
      g_lastSSLog = s.time;
      if(read)
         PrintFormat("[PAR] Sinal %s %s bloqueado pelo Smart Strength: score %+.2f%s (%s).",
                     (s.dir > 0) ? "COMPRA" : "VENDA", s.origin, score,
                     (bracket > 0) ? " [BUY]" : (bracket < 0) ? " [SELL]" : "", how);
      else
         PrintFormat("[PAR] Sinal %s bloqueado: Smart Strength não encontrado no gráfico.", s.origin);
     }
   return(allowed);
  }

//+------------------------------------------------------------------+
//| Lê o painel: primeiro a linha "TF: PAR +x.x [BUY]"; se não houver, |
//| calcula força da base menos força da cotada (ex.: EUR - JPY).     |
//+------------------------------------------------------------------+
bool PanelPairScore(double &score, int &bracket, string &how)
  {
   string base  = SymbolInfoString(_Symbol, SYMBOL_CURRENCY_BASE);
   string quote = SymbolInfoString(_Symbol, SYMBOL_CURRENCY_PROFIT);
   string pair  = base + quote;
   TextObj t[];
   int n = CollectTexts(t);
   bracket = 0;

   for(int i = 0; i < n; i++)
     {
      int p = StringFind(t[i].text, pair);
      if(p < 0 || StringFind(t[i].text, "[") < 0)
         continue;
      if(StringFind(t[i].text, "[BUY]") >= 0)
         bracket = 1;
      else if(StringFind(t[i].text, "[SELL]") >= 0)
         bracket = -1;
      if(ParseNumber(t[i].text, p + StringLen(pair), score))
        {
         how = "linha do par";
         return(true);
        }
      if(bracket != 0)
        {
         score = bracket;
         how   = "rótulo do par";
         return(true);
        }
     }

   double vb = 0, vq = 0;
   if(CurrencyValue(t, n, base, vb) && CurrencyValue(t, n, quote, vq))
     {
      score = vb - vq;
      how   = StringFormat("%s %+.1f / %s %+.1f", base, vb, quote, vq);
      return(true);
     }
   return(false);
  }

int CollectTexts(TextObj &t[])
  {
   ArrayResize(t, 0);
   int total = ObjectsTotal(0, -1, -1);
   for(int i = 0; i < total; i++)
     {
      string      name = ObjectName(0, i, -1, -1);
      ENUM_OBJECT type = (ENUM_OBJECT)ObjectGetInteger(0, name, OBJPROP_TYPE);
      if(type != OBJ_LABEL && type != OBJ_TEXT && type != OBJ_EDIT && type != OBJ_BUTTON)
         continue;
      if(InpSSNameContains != "" && StringFind(name, InpSSNameContains) < 0)
         continue;
      string text = ObjectGetString(0, name, OBJPROP_TEXT);
      if(text == "")
         continue;
      StringToUpper(text);
      int k = ArraySize(t);
      ArrayResize(t, k + 1);
      t[k].text = text;
      t[k].x    = (type == OBJ_TEXT) ? -1 : ObjectGetInteger(0, name, OBJPROP_XDISTANCE);
      t[k].y    = (type == OBJ_TEXT) ? -1 : ObjectGetInteger(0, name, OBJPROP_YDISTANCE);
     }
   return(ArraySize(t));
  }

//+------------------------------------------------------------------+
//| Valor da moeda: no mesmo texto ("EUR +2.4 **") ou no texto        |
//| numérico mais próximo na mesma linha do painel.                   |
//+------------------------------------------------------------------+
bool CurrencyValue(const TextObj &t[], int n, const string code, double &v)
  {
   for(int i = 0; i < n; i++)
     {
      int p = FindToken(t[i].text, code);
      if(p < 0)
         continue;
      if(ParseNumber(t[i].text, p + 3, v))
         return(true);
      if(t[i].y < 0)
         continue;

      long bestDx = -1;
      for(int j = 0; j < n; j++)
        {
         double w  = 0;
         long   dy = t[j].y - t[i].y;
         if(j == i || t[j].y < 0 || dy > InpSSRowTolerance || -dy > InpSSRowTolerance)
            continue;
         if(!ParseNumber(t[j].text, 0, w))
            continue;
         long dx = t[j].x - t[i].x;
         if(dx < 0)
            dx = -dx;
         if(bestDx < 0 || dx < bestDx)
           {
            bestDx = dx;
            v      = w;
           }
        }
      if(bestDx >= 0)
         return(true);
     }
   return(false);
  }

bool IsLetter(ushort c) { return((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')); }

// Posição do código como palavra isolada (EUR em ">EUR", não em "EURJPY").
int FindToken(const string s, const string code)
  {
   int len = StringLen(s);
   int p   = StringFind(s, code);
   while(p >= 0)
     {
      bool left  = (p == 0) || !IsLetter(StringGetCharacter(s, p - 1));
      bool right = (p + 3 >= len) || !IsLetter(StringGetCharacter(s, p + 3));
      if(left && right)
         return(p);
      p = StringFind(s, code, p + 1);
     }
   return(-1);
  }

// Primeiro número com sinal opcional a partir de "from"; ignora dígitos colados em letra (M30).
bool ParseNumber(const string s, int from, double &v)
  {
   int n = StringLen(s);
   for(int i = from; i < n; i++)
     {
      ushort c    = StringGetCharacter(s, i);
      bool   sign = (c == '+' || c == '-' || c == 0x2212);
      int    st   = sign ? i + 1 : i;
      if(st >= n)
         continue;
      ushort d = StringGetCharacter(s, st);
      if(d < '0' || d > '9')
         continue;
      if(!sign && i > 0 && IsLetter(StringGetCharacter(s, i - 1)))
         continue;
      int j = st;
      while(j < n)
        {
         ushort e = StringGetCharacter(s, j);
         if((e >= '0' && e <= '9') || e == '.' || e == ',')
            j++;
         else
            break;
        }
      string num = StringSubstr(s, st, j - st);
      StringReplace(num, ",", ".");
      v = StringToDouble(num);
      if(sign && c != '+')
         v = -v;
      return(true);
     }
   return(false);
  }

//+------------------------------------------------------------------+
//| Força própria: variação % média de cada moeda contra as outras 7  |
//| nas últimas InpSSNativeBars barras. Não é a fórmula do Smart       |
//| Strength; serve para backtest e como reserva.                     |
//+------------------------------------------------------------------+
bool NativePairScore(double &score)
  {
   string base  = SymbolInfoString(_Symbol, SYMBOL_CURRENCY_BASE);
   string quote = SymbolInfoString(_Symbol, SYMBOL_CURRENCY_PROFIT);
   int    p     = StringFind(_Symbol, base + quote);
   if(p < 0)
      return(false);
   string prefix = StringSubstr(_Symbol, 0, p);
   string suffix = StringSubstr(_Symbol, p + 6);

   double str[8];
   int    cnt[8];
   ArrayInitialize(str, 0);
   ArrayInitialize(cnt, 0);
   int ib = -1, iq = -1;

   for(int i = 0; i < 8; i++)
     {
      if(g_ccy[i] == base)
         ib = i;
      if(g_ccy[i] == quote)
         iq = i;
      for(int j = 0; j < 8; j++)
        {
         if(i == j)
            continue;
         string sym = prefix + g_ccy[i] + g_ccy[j] + suffix;
         if(!SymbolSelect(sym, true))
            continue;
         double c0 = iClose(sym, InpSSTF, 1);
         double cN = iClose(sym, InpSSTF, 1 + InpSSNativeBars);
         if(c0 <= 0 || cN <= 0)
            continue;
         double ch = (c0 - cN) / cN * 100.0;
         str[i] += ch;
         str[j] -= ch;
         cnt[i]++;
         cnt[j]++;
        }
     }
   if(ib < 0 || iq < 0 || cnt[ib] == 0 || cnt[iq] == 0)
      return(false);
   score = str[ib] / cnt[ib] - str[iq] / cnt[iq];
   return(true);
  }

//+------------------------------------------------------------------+
void Execute(const Signal &s)
  {
   int cur = CurrentDirection();
   if(cur == s.dir && InpOnlyOnePosition)
     {
      PrintFormat("[PAR] Sinal %s ignorado: já existe posição no mesmo sentido.", s.origin);
      return;
     }
   if(cur == -s.dir)
     {
      if(InpCloseOnOpposite)
         CloseAll();
      else if(InpOnlyOnePosition)
        {
         PrintFormat("[PAR] Sinal %s ignorado: posição contrária aberta.", s.origin);
         return;
        }
     }

   double entry = (s.dir > 0) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   // Caixa é desenhada no Bid; stop de venda dispara no Ask, por isso soma o spread.
   double spread = SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double sl     = (s.dir > 0) ? s.lo - InpSLBufferPoints * _Point
                               : s.hi + InpSLBufferPoints * _Point + spread;
   if((s.dir > 0 && sl >= entry) || (s.dir < 0 && sl <= entry))
     {
      PrintFormat("[PAR] Sinal %s descartado: preço já está além do stop.", s.origin);
      return;
     }

   double dist    = MathAbs(entry - sl);
   double distPts = dist / _Point;
   long   minStop = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   if(distPts < InpMinSLPoints || distPts < minStop || (InpMaxSLPoints > 0 && distPts > InpMaxSLPoints))
     {
      PrintFormat("[PAR] Sinal %s descartado: stop de %.0f pontos fora dos limites.", s.origin, distPts);
      return;
     }

   double tp = 0;
   if(InpRR > 0)
      tp = (s.dir > 0) ? entry + InpRR * dist : entry - InpRR * dist;
   sl = NormalizeDouble(sl, _Digits);
   tp = NormalizeDouble(tp, _Digits);

   double lot = CalcLot(dist);
   if(lot <= 0)
     {
      PrintFormat("[PAR] Sinal %s descartado: lote calculado abaixo do mínimo.", s.origin);
      return;
     }

   string comment = StringSubstr("PAR " + s.origin, 0, 31);
   bool ok = (s.dir > 0) ? trade.Buy(lot, _Symbol, 0, sl, tp, comment)
                         : trade.Sell(lot, _Symbol, 0, sl, tp, comment);
   PrintFormat("[PAR] %s %s lote=%.2f sl=%s tp=%s -> %s (retcode %u)",
               (s.dir > 0) ? "COMPRA" : "VENDA", s.origin, lot,
               DoubleToString(sl, _Digits), DoubleToString(tp, _Digits),
               ok ? "enviada" : "falhou", trade.ResultRetcode());
  }

//+------------------------------------------------------------------+
double CalcLot(double dist)
  {
   double lot = InpFixedLot;
   if(InpLotMode == LOT_RISK_PERCENT)
     {
      double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      if(tickSize <= 0 || tickValue <= 0)
         return(0);
      double riskMoney  = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPercent / 100.0;
      double lossPerLot = dist / tickSize * tickValue;
      lot = riskMoney / lossPerLot;
     }

   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double vMin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vMax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0)
      return(0);
   lot = MathFloor(lot / step) * step;
   if(lot < vMin)
      lot = (InpLotMode == LOT_FIXED) ? vMin : 0; // no modo risco, não arrisca acima do definido
   lot = MathMin(lot, vMax);
   int digits = (int)MathMax(0, MathCeil(-MathLog10(step)));
   return(NormalizeDouble(lot, digits));
  }

//+------------------------------------------------------------------+
int CurrentDirection()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(PositionGetSymbol(i) != _Symbol || (ulong)PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;
      return(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? 1 : -1);
     }
   return(0);
  }

void CloseAll()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || PositionGetString(POSITION_SYMBOL) != _Symbol ||
         (ulong)PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;
      trade.PositionClose(ticket);
     }
  }

//+------------------------------------------------------------------+
//| Diagnóstico: lista os objetos para confirmar como o Radar desenha |
//| as caixas (nome, tipo, cor, estilo, horários e preços).           |
//+------------------------------------------------------------------+
void DumpObjects(bool all)
  {
   int total = ObjectsTotal(0, -1, -1);
   PrintFormat("[PAR diag] %d objetos no gráfico", total);
   for(int i = 0; i < total; i++)
     {
      string      name = ObjectName(0, i, -1, -1);
      ENUM_OBJECT type = (ENUM_OBJECT)ObjectGetInteger(0, name, OBJPROP_TYPE);
      if(!all && type != OBJ_RECTANGLE)
         continue;
      PrintFormat("[PAR diag] %s | %s | cor=%s | estilo=%d | t1=%s t2=%s | p1=%s p2=%s | texto='%s'",
                  name, EnumToString(type),
                  ColorToString((color)ObjectGetInteger(0, name, OBJPROP_COLOR), true),
                  (int)ObjectGetInteger(0, name, OBJPROP_STYLE),
                  TimeToString((datetime)ObjectGetInteger(0, name, OBJPROP_TIME, 0)),
                  TimeToString((datetime)ObjectGetInteger(0, name, OBJPROP_TIME, 1)),
                  DoubleToString(ObjectGetDouble(0, name, OBJPROP_PRICE, 0), _Digits),
                  DoubleToString(ObjectGetDouble(0, name, OBJPROP_PRICE, 1), _Digits),
                  ObjectGetString(0, name, OBJPROP_TEXT));
     }
  }
//+------------------------------------------------------------------+
