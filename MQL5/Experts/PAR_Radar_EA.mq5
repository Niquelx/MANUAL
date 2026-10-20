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

input group "=== Filtros ==="
input int  InpMaxSpreadPoints  = 30; // 0 = sem filtro
input int  InpStartHour        = 0;  // hora do servidor
input int  InpEndHour          = 24;
input bool InpOnlyOnePosition  = true;
input bool InpCloseOnOpposite  = true;

input group "=== Gestão ==="
input ENUM_LOT_MODE InpLotMode        = LOT_FIXED;
input double        InpFixedLot       = 0.01;
input double        InpRiskPercent    = 1.0;
input int           InpSLBufferPoints = 20;   // stop além da caixa
input double        InpRR             = 2.0;  // alvo = N x risco (0 = sem TP)
input int           InpMinSLPoints    = 50;
input int           InpMaxSLPoints    = 1500; // 0 = sem limite
input int           InpSlippagePoints = 10;
input ulong         InpMagic          = 20261020;

struct Signal
  {
   int      dir;    // 1 compra, -1 venda, 0 nenhum
   double   hi;
   double   lo;
   datetime time;   // início do padrão, usado para não repetir o sinal
   string   origin;
  };

CTrade   trade;
string   g_gvKey;
int      g_lastRectCount = -1;
datetime g_lastNativeBar = 0;

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

   if(InpSource == SRC_RADAR_OBJECTS && InpDiagnostic)
      DumpObjects(true);

   EventSetTimer(MathMax(1, InpScanSeconds));
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer()                  { Process(); }
void OnTick()                   { Process(); }

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
      return; // sinal continua válido e pode ser executado na próxima leitura

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
   double sl    = (s.dir > 0) ? s.lo - InpSLBufferPoints * _Point : s.hi + InpSLBufferPoints * _Point;
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
