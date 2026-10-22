# PAR_Radar_EA

EA para MT5 que executa os sinais do indicador **Price Action Radar v1.2** lendo as caixas que ele desenha no gráfico.

## Como funciona

- Caixa tracejada na cor `PatternBoxBullColor` (34,170,129) = compra.
- Caixa tracejada na cor `PatternBoxBearColor` (DeepPink) = venda.
- Stop além da extremidade da caixa (+ `InpSLBufferPoints`), alvo em `InpRR` x risco.
- Cada caixa é operada uma única vez (controle por variável global do terminal).
- **Filtro Smart Strength**: só entra a favor da força do par. Compra exige score > `InpSSMinScore`; venda exige score < -`InpSSMinScore`. Se o painel mostrar `[BUY]`/`[SELL]`, o rótulo também precisa concordar (`InpSSUseBracket`). Sem leitura do painel, o EA não opera.

## Filtro Smart Strength

O EA procura no gráfico, nesta ordem:

1. A linha do par, ex.: `M30: EURJPY +4.7 [BUY]`.
2. Se não houver, os valores das duas moedas (ex.: `EUR +2.4` e `JPY -2.3`) e calcula base menos cotada (+4.7).

Modos (`InpSSMode`):

| Modo | Uso |
|---|---|
| `SS_PANEL` (padrão) | Lê o painel. Sem painel, bloqueia. |
| `SS_PANEL_OR_NATIVE` | Lê o painel; se não achar, usa o cálculo próprio. |
| `SS_NATIVE` | Só cálculo próprio (variação % média de cada moeda contra as outras 7). Serve para backtest; não é a fórmula do Smart Strength. |
| `SS_OFF` | Sem filtro. |

Se o painel for desenhado como imagem (canvas) e não como texto, o EA não consegue lê-lo: o log de diagnóstico mostrará isso e será preciso usar `SS_NATIVE`.

## Instalação

1. Copie `MQL5/Experts/PAR_Radar_EA.mq5` para `Arquivo > Abrir pasta de dados > MQL5/Experts`.
2. Compile no MetaEditor (F7).
3. Anexe o EA **no mesmo gráfico** onde está o Price Action Radar (objetos são lidos por gráfico).
4. Mantenha as cores do EA iguais às do indicador. Se mudar a cor no Radar, mude no EA.

## Primeiro uso (obrigatório)

Rode em conta demo com `InpDiagnostic = true` e confira na aba **Experts** como o Radar nomeia e desenha as caixas:

- Se a caixa não for `OBJ_RECTANGLE` (ex.: 4 linhas `OBJ_TREND`), o EA precisa de ajuste.
- Se o nome tiver um prefixo fixo (ex.: `PAR_Box_`), preencha `InpNameContains` para evitar falsos positivos.
- Confira se os textos do Smart Strength aparecem no log (`OBJ_LABEL` com `texto='EUR +2.4 **'` ou parecido). Se o painel tiver prefixo de nome, preencha `InpSSNameContains`.
- Ao bloquear, o EA registra: `Sinal ... bloqueado pelo Smart Strength: score ...`.
- Se a caixa incluir a barra em formação, avalie `InpOnlyClosedBar` (true evita sinal que some depois).

## Limitações

- O modo `SRC_RADAR_OBJECTS` depende de objetos gráficos; o backtest no Testador de Estratégia provavelmente não reproduz o Radar. Valide em demo, em tempo real.
- O modo `SRC_NATIVE` recalcula Engolfo e Pin Bar no próprio EA e pode ser backtestado, mas não replica a lógica interna do Radar (código fechado), principalmente o CRT.
