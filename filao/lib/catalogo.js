// Catálogo de camadas de fontes oficiais.
// tipo "arcgis": ArcGIS MapServer (renderizado via /export). "camadas" = IDs das subcamadas.
// tipo "wms": serviço OGC WMS (GeoServer/MapServer). "camada" = nome da camada.
// tipo "local": desenhada a partir da base local (ex.: processos com CFEM).
// "busca": expressão usada para localizar a camada automaticamente no GetCapabilities / listagem
//          do serviço, caso o nome configurado tenha mudado. Endereços verificados em nov/2026
//          por busca na web; a disponibilidade real só é testada no seu computador (botão "Testar").

const ANM = 'https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/MapServer';
const SGB_ARC = 'https://geoportal.sgb.gov.br/server/rest/services';
const SGB_WMS = 'https://geoservicos.sgb.gov.br/geoserver/wms';

export const GRUPOS_CAMADAS = ['Destaques', 'Áreas especiais', 'Geociências', 'ANM (oficial, online)'];

export const CATALOGO = [
  // ---------- Áreas especiais ----------
  {
    id: 'terras_indigenas', nome: 'Terras Indígenas', grupos: ['Áreas especiais'], fonte: 'FUNAI',
    tipo: 'wms', url: 'https://geoserver.funai.gov.br/geoserver/ows', camada: 'Funai:tis_poligonais',
    busca: 'tis_?poligonais|terras?_?indigenas?', evitar: 'amazonia|ponto|aldeia',
    info: 'https://www.gov.br/funai/pt-br/atuacao/terras-indigenas/geoprocessamento-e-mapas',
    descricao: 'Limites das terras indígenas em todas as fases de regularização (GeoServer da FUNAI).',
  },
  {
    id: 'unidades_conservacao', nome: 'Unidades de Conservação', grupos: ['Áreas especiais'], fonte: 'MMA / CNUC',
    tipo: 'wms', url: 'https://cnuc-mapserv.mma.gov.br/cgi-bin/mapserv', camada: '',
    busca: 'unidade|^uc|cnuc|conserva',
    info: 'https://www.gov.br/mma/pt-br/assuntos/biodiversidade-e-biomas/areas-protegidas/plataforma-cnuc-1',
    descricao: 'Cadastro Nacional de Unidades de Conservação (federais, estaduais e municipais). Se o serviço não responder, baixe o shapefile oficial do CNUC e importe em "Importar KML e Shapefile".',
  },
  {
    id: 'restricoes_anm', nome: 'Restrições Administrativas', grupos: ['Áreas especiais'], fonte: 'ANM / SIGMINE',
    tipo: 'arcgis', url: ANM, camadas: [1, 3, 4],
    info: 'https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/MapServer',
    descricao: 'Áreas de bloqueio, áreas de proteção de fonte (água mineral) e reservas garimpeiras, direto do SIGMINE.',
  },
  {
    id: 'areas_protegidas', nome: 'Áreas Ambientais Protegidas', grupos: ['Destaques', 'Áreas especiais'], fonte: 'FUNAI + MMA',
    tipo: 'composta', componentes: ['unidades_conservacao', 'terras_indigenas'],
    descricao: 'Atalho que liga juntas Unidades de Conservação (CNUC/MMA) e Terras Indígenas (FUNAI).',
  },
  {
    id: 'sicar', nome: 'Imóveis Rurais - SICAR', grupos: ['Destaques', 'Áreas especiais'], fonte: 'SFB / SICAR',
    tipo: 'wms', url: 'https://geoserver.car.gov.br/geoserver/sicar/wms', camada: '', multiplas: true,
    busca: 'sicar_imoveis_', minZoom: 11,
    info: 'https://consultapublica.car.gov.br/publico/imoveis/index',
    descricao: 'Perímetros declarados no Cadastro Ambiental Rural (uma camada por UF). Pesado: só aparece a partir do zoom 11.',
  },

  // ---------- Geociências (Serviço Geológico do Brasil) ----------
  {
    id: 'ocorrencias_sgb', nome: 'Ocorrências Minerais - SGB', grupos: ['Destaques', 'Geociências'], fonte: 'SGB/CPRM',
    tipo: 'arcgis', url: `${SGB_ARC}/geologia/ocorrencias/MapServer`, camadas: [0],
    pasta: `${SGB_ARC}/geologia`, buscaServico: 'ocorrenc|recursos_minerais',
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Estações onde o SGB cadastrou ocorrências de minerais e minérios de interesse econômico.',
  },
  {
    id: 'minas_cfem', nome: 'Minas Ativas - CFEM', grupos: ['Geociências'], fonte: 'ANM (CFEM) + SIGMINE',
    tipo: 'local', categoria: 'minas_cfem', cor: '#f08c00',
    info: 'https://www.gov.br/anm/pt-br/acesso-a-informacao/dados-abertos',
    descricao: 'Processos da base local com recolhimento de CFEM nos últimos meses (configurável). Requer importar a planilha de arrecadação da CFEM na aba Dados.',
  },
  {
    id: 'geoquimica_sgb', nome: 'Geoquímica - SGB', grupos: ['Destaques', 'Geociências'], fonte: 'SGB/CPRM',
    tipo: 'wms', url: 'https://opendata.sgb.gov.br/geoserver/ows', camada: 'vw_cprm_geoq_b_d',
    busca: 'geoq|sedimento|geoquim',
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Pontos de amostragem e análises geoquímicas (sedimento de corrente e solo) do SGB.',
  },
  {
    id: 'geologia_100k', nome: 'Mapa Geológico - 100k - SGB', grupos: ['Geociências'], fonte: 'SGB/CPRM',
    tipo: 'wms', url: SGB_WMS, camada: 'geosgb:litoestratigrafia_100k',
    busca: 'litoestratigrafia_?100(k|000)', minZoom: 8,
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Unidades litoestratigráficas das folhas 1:100.000 publicadas.',
  },
  {
    id: 'geologia_250k', nome: 'Mapa Geológico - 250k - SGB', grupos: ['Geociências'], fonte: 'SGB/CPRM',
    tipo: 'wms', url: SGB_WMS, camada: 'geosgb:litoestratigrafia_250k',
    busca: 'litoestratigrafia_?250(k|000)', minZoom: 6,
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Unidades litoestratigráficas das folhas 1:250.000.',
  },
  {
    id: 'geologia_350k', nome: 'Mapa Geológico - 350k - SGB', grupos: ['Geociências'], fonte: 'SGB/CPRM (mapas estaduais)',
    tipo: 'arcgis', url: `${SGB_ARC}/geologia/litoestratigrafia_estados/MapServer`, camadas: [],
    buscaSubcamada: '1:3[0-9]{2}\\.?000',
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Mapas geológicos estaduais com escala na faixa 1:300.000–1:399.000 (subcamadas escolhidas pelo nome).',
  },
  {
    id: 'geologia_500k', nome: 'Mapa Geológico - 500k - SGB', grupos: ['Geociências'], fonte: 'SGB/CPRM (mapas estaduais)',
    tipo: 'arcgis', url: `${SGB_ARC}/geologia/litoestratigrafia_estados/MapServer`, camadas: [],
    buscaSubcamada: '1:(4|5|6|7)[0-9]{2}\\.?000',
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Mapas geológicos estaduais com escala na faixa 1:400.000–1:799.000.',
  },
  {
    id: 'geologia_1m', nome: 'Mapa Geológico - 1M - SGB', grupos: ['Destaques', 'Geociências'], fonte: 'SGB/CPRM',
    tipo: 'wms', url: SGB_WMS, camada: 'geosgb:litoestratigrafia_1m',
    busca: 'litoestratigrafia_?1(m|000000)$',
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Carta Geológica do Brasil ao Milionésimo (46 folhas).',
  },
  {
    id: 'bacias_sedimentares', nome: 'Bacias Sedimentares', grupos: ['Geociências'], fonte: 'SGB/CPRM',
    tipo: 'wms', url: SGB_WMS, camada: 'geosgb:bacias_sedimentares', busca: 'bacias?_?sediment',
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Limites das bacias sedimentares brasileiras (terrestres e marítimas).',
  },
  {
    id: 'provincias_tectonicas', nome: 'Províncias Tectônicas', grupos: ['Geociências'], fonte: 'SGB/CPRM',
    tipo: 'arcgis', url: `${SGB_ARC}/Mapa_de_Prov%C3%ADncias_Estruturais/MapServer`, camadas: [],
    pasta: SGB_ARC, buscaServico: 'provincias?_estrutura|provincias?_tecton',
    info: 'https://geosgb.sgb.gov.br/', descricao: 'Mapa de Províncias Estruturais do Brasil.',
  },

  {
    id: 'aerogeo_projetos', nome: 'Projetos aerogeofísicos - SGB', grupos: ['Geociências'], fonte: 'SGB/CPRM',
    tipo: 'arcgis', url: '', camadas: [], pasta: SGB_ARC, buscaServico: 'aerogeof|aerolevant|projetos?_aero|^aero',
    info: 'https://www.sgb.gov.br/aerogeofisica',
    descricao: 'Limites dos projetos de levantamento aerogeofísico. Mostra qual projeto baixar no GeoSGB para usar na GeoAnálise. Endereço localizado automaticamente no geoportal do SGB.',
  },
  {
    id: 'aerogeo_mag', nome: 'Magnetometria regional - SGB', grupos: ['Geociências'], fonte: 'SGB/CPRM',
    tipo: 'arcgis', url: '', camadas: [], pasta: SGB_ARC, buscaServico: 'magnet|campo_?magn|anomalia_?magn',
    info: 'https://www.sgb.gov.br/aerogeofisica',
    descricao: 'Mosaico magnetométrico publicado pelo SGB, se disponível no geoportal (localizado automaticamente).',
  },
  {
    id: 'aerogeo_gama', nome: 'Gamaespectrometria regional - SGB', grupos: ['Geociências'], fonte: 'SGB/CPRM',
    tipo: 'arcgis', url: '', camadas: [], pasta: SGB_ARC, buscaServico: 'gama|ternari|radiometr',
    info: 'https://www.sgb.gov.br/aerogeofisica',
    descricao: 'Mosaico gamaespectrométrico (ternário) publicado pelo SGB, se disponível no geoportal (localizado automaticamente).',
  },

  // ---------- ANM (camadas oficiais online, não exigem importação) ----------
  {
    id: 'anm_processos', nome: 'Processos minerários ativos (online)', grupos: ['ANM (oficial, online)'], fonte: 'ANM / SIGMINE',
    tipo: 'arcgis', url: ANM, camadas: [0], minZoom: 9,
    info: 'https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/MapServer/0',
    descricao: 'Polígonos atualizados diariamente pela ANM, renderizados direto do servidor oficial (útil sem importar a base).',
  },
  { id: 'anm_bloqueio', nome: 'Áreas de bloqueio', grupos: ['ANM (oficial, online)'], fonte: 'ANM / SIGMINE', tipo: 'arcgis', url: ANM, camadas: [3], info: `${ANM}/3`, descricao: 'Áreas bloqueadas para atividade minerária.' },
  { id: 'anm_fonte', nome: 'Áreas de proteção de fonte', grupos: ['ANM (oficial, online)'], fonte: 'ANM / SIGMINE', tipo: 'arcgis', url: ANM, camadas: [1], info: `${ANM}/1`, descricao: 'Proteção de fontes de água mineral.' },
  { id: 'anm_arrendamento', nome: 'Arrendamentos', grupos: ['ANM (oficial, online)'], fonte: 'ANM / SIGMINE', tipo: 'arcgis', url: ANM, camadas: [2], info: `${ANM}/2`, descricao: 'Áreas arrendadas.' },
  { id: 'anm_garimpeiras', nome: 'Reservas garimpeiras', grupos: ['ANM (oficial, online)'], fonte: 'ANM / SIGMINE', tipo: 'arcgis', url: ANM, camadas: [4], info: `${ANM}/4`, descricao: 'Reservas garimpeiras.' },
];

export const camadaPorId = (id) => CATALOGO.find((c) => c.id === id);
