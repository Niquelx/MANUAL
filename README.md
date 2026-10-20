# PAR_Radar_EA

EA para MT5 que executa os sinais do indicador **Price Action Radar v1.2** lendo as caixas que ele desenha no gráfico.

## Como funciona

- Caixa tracejada na cor `PatternBoxBullColor` (34,170,129) = compra.
- Caixa tracejada na cor `PatternBoxBearColor` (DeepPink) = venda.
- Stop além da extremidade da caixa (+ `InpSLBufferPoints`), alvo em `InpRR` x risco.
- Cada caixa é operada uma única vez (controle por variável global do terminal).

## Instalação

1. Copie `MQL5/Experts/PAR_Radar_EA.mq5` para `Arquivo > Abrir pasta de dados > MQL5/Experts`.
2. Compile no MetaEditor (F7).
3. Anexe o EA **no mesmo gráfico** onde está o Price Action Radar (objetos são lidos por gráfico).
4. Mantenha as cores do EA iguais às do indicador. Se mudar a cor no Radar, mude no EA.

## Primeiro uso (obrigatório)

Rode em conta demo com `InpDiagnostic = true` e confira na aba **Experts** como o Radar nomeia e desenha as caixas:

- Se a caixa não for `OBJ_RECTANGLE` (ex.: 4 linhas `OBJ_TREND`), o EA precisa de ajuste.
- Se o nome tiver um prefixo fixo (ex.: `PAR_Box_`), preencha `InpNameContains` para evitar falsos positivos.
- Se a caixa incluir a barra em formação, avalie `InpOnlyClosedBar` (true evita sinal que some depois).

## Limitações

- O modo `SRC_RADAR_OBJECTS` depende de objetos gráficos; o backtest no Testador de Estratégia provavelmente não reproduz o Radar. Valide em demo, em tempo real.
- O modo `SRC_NATIVE` recalcula Engolfo e Pin Bar no próprio EA e pode ser backtestado, mas não replica a lógica interna do Radar (código fechado), principalmente o CRT.
