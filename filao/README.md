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

## Aba Filtros
Marque um ou mais filtros (combinação "OU"); o mapa e a lista mostram o resultado, somado aos campos da aba Busca.

| Grupo | Filtros | Como é calculado |
|---|---|---|
| Meus grupos minerários | grupos criados por você | processos adicionados pela ficha do processo |
| Áreas em disponibilidade | Aguardando Oferta Pública, Oferta Pública, Arrematada em Oferta Pública, Em Leilão, Arrematada em Leilão, Área Livre (Fracassadas), Área Retirada (Retificação) | texto do último evento e fase do SIGMINE |
| Status | Pedido de Pesquisa em análise, Pesquisa Mineral Autorizada, Pedido de Lavra em análise, Lavra Autorizada, Bloqueio Administrativo, Área Livre, Disponibilidade não julgada | fase oficial agrupada; "Área Livre" = processo que saiu da base ativa e cuja área não toca nenhum processo ativo |
| Pesquisas | Pedido de Registro Recente, Título minerário publicado, Renovação Título Minerário, Título Próximo ao Vencimento | data em que o processo apareceu na base, data do evento, eventos de prorrogação; vencimento é **estimado** (alvará + prazo configurável) |
| Criar filtro personalizado | seus próprios filtros | expressões sobre fase/evento + campos da Busca |

As regras ficam em `lib/categorias.js` e podem ser ajustadas. Elas dependem do texto dos eventos da ANM, que pode variar: confira as contagens com a sua base real.

## Aba Camadas (fontes oficiais, online)
| Grupo | Camada | Fonte / serviço |
|---|---|---|
| Destaques | Áreas Ambientais Protegidas, Ocorrências Minerais, Geoquímica, Mapa Geológico 1M, Imóveis Rurais SICAR | atalhos das camadas abaixo |
| Áreas especiais | Terras Indígenas | FUNAI GeoServer (WMS) |
| | Unidades de Conservação | MMA/CNUC (WMS MapServer) |
| | Restrições Administrativas | ANM SIGMINE (bloqueio, proteção de fonte, reservas garimpeiras) |
| | Imóveis Rurais - SICAR | GeoServer do CAR (WMS, zoom 11+) |
| Geociências | Ocorrências Minerais | SGB ArcGIS `geologia/ocorrencias` |
| | Minas Ativas - CFEM | base local + planilha de arrecadação CFEM da ANM |
| | Geoquímica | SGB GeoServer de dados abertos |
| | Mapa Geológico 100k, 250k, 1M | SGB GeoServer (`litoestratigrafia_*`) |
| | Mapa Geológico 350k e 500k | SGB ArcGIS `litoestratigrafia_estados` (mapas estaduais escolhidos pela escala no nome) |
| | Bacias Sedimentares | SGB GeoServer |
| | Províncias Tectônicas | SGB ArcGIS `Mapa_de_Províncias_Estruturais` |
| ANM (online) | Processos ativos, bloqueio, proteção de fonte, arrendamentos, reservas garimpeiras | ANM ArcGIS `SIGMINE/dados_anm` |

- Clique no mapa com camadas ligadas para ver os atributos (consulta feita pelo servidor local).
- Botão ⓘ: descrição, link da fonte, opacidade, legenda e endereço do serviço (editável).
- **Testar conexão de todas**: o servidor lê o GetCapabilities/listagem de cada serviço e corrige sozinho o nome da camada se ele tiver mudado. Bolinha verde = respondeu; laranja = erro (a mensagem diz o motivo).
- Se um órgão tirar o serviço do ar, use "Importar KML e Shapefile" com o arquivo oficial baixado do site do órgão.
- Alguns servidores do governo usam certificados ICP-Brasil. Se o teste acusar erro de certificado, rode `NODE_EXTRA_CA_CERTS=/caminho/cadeia-icp.pem npm start` (ou Node 23+ com `node --use-system-ca server.js`).

## Limites (leia antes de usar)
- Alertas dependem de você atualizar a base (manual ou automática). O sistema compara uma versão da base com a anterior; não lê o Diário Oficial nem o SEI.
- A "área livre" considera só o que foi importado localmente. Não substitui a consulta oficial de disponibilidade da ANM.
- Shapefiles devem estar em coordenadas geográficas (SIRGAS 2000/WGS84). Arquivos em UTM são recusados com aviso.
- Os endereços das camadas foram conferidos por busca na web em nov/2026, mas não puderam ser acessados do ambiente onde o código foi escrito. O teste real acontece no seu computador.
- Uso pessoal: o servidor escuta só em `127.0.0.1`. Não há login; não exponha na internet.

## Testes
```bash
npm test
```
