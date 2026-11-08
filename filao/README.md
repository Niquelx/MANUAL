# Filão: inteligência minerária para uso pessoal

Aplicação local (roda no seu computador) para pesquisar processos minerários da ANM no mapa, monitorar mudanças, receber alertas e analisar interferências de áreas.

## Requisitos
- Node.js 20 ou superior (https://nodejs.org)

## Instalação
```bash
cd filao
npm install
npm run exemplo   # opcional: cria uma base FICTÍCIA para testar
npm start         # abre em http://127.0.0.1:3210
```

## Carregar dados reais
- Pela interface: aba **Dados** → escolha a UF → **Baixar e importar** (baixa o shapefile do SIGMINE/ANM).
- Pela linha de comando: `npm run importar -- MG GO PA`
- Por arquivo: aba **Dados** → importar `.zip` (shapefile), GeoJSON, KML ou KMZ com o atributo `PROCESSO` (ou `NUMERO` + `ANO`).

A URL padrão da ANM fica em **Dados → Configurações**. Confira no portal de dados abertos da ANM se o endereço ainda é o vigente; se mudar, basta editar o modelo (`{UF}` vira a sigla).

Para remover a base de exemplo: aba **Dados** → **Remover** em cada UF.

## Funcionalidades
| Módulo | O que faz |
|---|---|
| Busca | Por número, titular, substância, fase, UF, uso, ano, área, texto do último evento, área visível do mapa; facetas por fase; paginação; ordenação |
| Mapa | Polígonos coloridos por fase; mapas base OSM, satélite, topográfico e claro; coordenadas do cursor; escala |
| Ficha do processo | Dados completos, histórico de alterações, processos no entorno, exportação individual, link externo configurável |
| Análise de área | Desenhe/cole coordenadas (decimal ou GMS)/importe arquivo; calcula interferências, área ocupada, **área livre** (exporta KML/GeoJSON) |
| Monitorados | Lista de processos acompanhados com anotações |
| Alertas | Gerados a cada atualização da base: mudança de fase, evento, titular, substância, uso ou área; processo que sumiu da base; novo processo em região de interesse. Notificação do navegador |
| Regiões | Polígonos de interesse monitorados; lista os processos dentro |
| Camadas | Importe camadas temáticas (geologia, UCs, terras indígenas, CAR, SIGEF etc.) em SHP/GeoJSON/KML/KMZ |
| Painel | Totais, distribuição por fase, substância, titular e UF (clique para filtrar) |
| Dados | Download ANM por UF, atualização automática periódica, histórico de importações, backup/restauração |
| Exportação | CSV (Excel), GeoJSON, KML |

## Limites (leia antes de usar)
- Alertas dependem de você atualizar a base (manual ou automática). O sistema compara uma versão da base com a anterior; não lê o Diário Oficial nem o SEI.
- A "área livre" considera só o que foi importado localmente. Não substitui a consulta oficial de disponibilidade da ANM.
- Shapefiles devem estar em coordenadas geográficas (SIRGAS 2000/WGS84). Arquivos em UTM são recusados com aviso.
- Uso pessoal: o servidor escuta só em `127.0.0.1`. Não há login; não exponha na internet.

## Testes
```bash
npm test
```
