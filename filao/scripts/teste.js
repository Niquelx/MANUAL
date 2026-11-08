// Teste de ponta a ponta da API com base temporária e dados fictícios.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filao-teste-'));
process.env.DADOS = dir;
const { servidor } = await import('../server.js');
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
const URL_BASE = `http://127.0.0.1:${servidor.address().port}`;
const req = async (rota, opt = {}) => {
  const r = await fetch(URL_BASE + rota, opt);
  const t = await r.text();
  try { return { status: r.status, corpo: JSON.parse(t) }; } catch { return { status: r.status, corpo: t }; }
};
const json = (corpo, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
const quad = (x, y, d) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const fc = (feats) => JSON.stringify({ type: 'FeatureCollection', features: feats });
const proc = (p, fase, x, y, d = 0.01, extra = {}) => ({ type: 'Feature', properties: { PROCESSO: p, FASE: fase, NOME: 'TITULAR TESTE', SUBS: 'OURO', UF: 'MG', ULT_EVENTO: 'EVENTO A', ...extra }, geometry: quad(x, y, d) });

let ok = 0;
const passo = (nome) => console.log(`✔ ${nome}`) || ok++;

// 1. Importação GeoJSON
let r = await req('/api/importar?arquivo=a.geojson', { method: 'POST', body: fc([
  proc('830.001/2020', 'AUTORIZAÇÃO DE PESQUISA', -44, -20),
  proc('830.002/2021', 'CONCESSÃO DE LAVRA', -43.99, -20, 0.01, { SUBS: 'FERRO' }),
]) });
assert.equal(r.status, 200); assert.equal(r.corpo.total, 2); passo('importa GeoJSON');

// 2. Busca
r = await req('/api/busca?substancia=ouro'); assert.equal(r.corpo.total, 1); passo('busca por substância (sem acento/caixa)');
r = await req('/api/busca?processo=8300022021'); assert.equal(r.corpo.itens[0].processo, '830.002/2021'); passo('busca por número');
r = await req('/api/busca?q=lavra ferro'); assert.equal(r.corpo.total, 1); passo('busca livre multi-termo');
r = await req('/api/mapa?bbox=-45,-21,-43,-19'); assert.equal(r.corpo.features.length, 2); passo('mapa por bbox');

// 3. Monitorar + região
await req('/api/monitorados', json({ processo: '830.001/2020', nota: 'cliente X' }));
await req('/api/regioes', json({ nome: 'Alvo', geometria: quad(-43.5, -20, 0.2) }));

// 4. Reimportação com alteração, novo processo na região e processo removido
r = await req('/api/importar?arquivo=b.geojson', { method: 'POST', body: fc([
  proc('830.001/2020', 'REQUERIMENTO DE LAVRA', -44, -20, 0.01, { ULT_EVENTO: 'EVENTO B' }),
  proc('830.003/2022', 'REQUERIMENTO DE PESQUISA', -43.45, -19.95),
]) });
assert.equal(r.corpo.novos, 1); assert.equal(r.corpo.alterados, 1);
r = await req('/api/alertas');
const tipos = r.corpo.map((a) => a.tipo).sort();
assert.deepEqual(tipos, ['alteracao', 'alteracao', 'regiao']); passo('alertas de alteração (fase+evento) e nova área na região');
r = await req('/api/processo?id=' + encodeURIComponent('830.001/2020'));
assert.equal(r.corpo.historico.length, 2); assert.equal(r.corpo.monitorado.nota, 'cliente X'); passo('histórico e anotação');

await req('/api/monitorados', json({ processo: '830.003/2022' }));
await req('/api/importar?arquivo=c.geojson', { method: 'POST', body: fc([proc('830.001/2020', 'REQUERIMENTO DE LAVRA', -44, -20, 0.01, { ULT_EVENTO: 'EVENTO B' })]) });
r = await req('/api/alertas?nao_lidos=1');
assert.ok(r.corpo.some((a) => a.tipo === 'removido' && a.processo === '830.003/2022')); passo('alerta de processo removido da base');

// 5. Interferência / área livre
r = await req('/api/interferencia', json({ geometria: quad(-44.005, -20.005, 0.01) }));
assert.equal(r.corpo.interferencias.length, 1);
assert.ok(r.corpo.area_livre_ha > 0 && r.corpo.area_ocupada_ha > 0);
assert.ok(Math.abs(r.corpo.area_livre_ha + r.corpo.area_ocupada_ha - r.corpo.area_alvo_ha) < 0.5); passo('interferência e área livre');

// 6. KML import + camadas
const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>UC</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-44,-20,0 -43.9,-20,0 -43.9,-19.9,0 -44,-20,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
r = await req('/api/camadas?nome=UC&arquivo=uc.kml', { method: 'POST', body: kml });
assert.equal(r.corpo.total, 1);
const c = await req('/api/camada?id=' + r.corpo.id); assert.equal(c.corpo.features[0].properties.name, 'UC'); passo('camada KML');

// 7. Exportações
for (const f of ['csv', 'geojson', 'kml']) {
  const e = await req('/api/exportar?formato=' + f); assert.equal(e.status, 200);
  assert.ok(String(typeof e.corpo === 'string' ? e.corpo : JSON.stringify(e.corpo)).includes('830.001/2020'));
}
passo('exportação CSV/GeoJSON/KML');

// 8. Segurança básica: path traversal
r = await req('/../server.js'); assert.notEqual(r.status, 200);
r = await req('/api/camada?id=../estado'); assert.equal(r.status, 404); passo('bloqueio de path traversal');

// 9. Backup
r = await req('/api/backup'); assert.ok(r.corpo.monitorados.length >= 1); passo('backup');


// 10. Filtros prontos, área livre e registro recente
r = await req('/api/categorias');
assert.ok(r.corpo.categorias.length >= 18 && r.corpo.contagens.pesquisa_autorizada === 0 && r.corpo.contagens.pedido_lavra === 1);
r = await req('/api/busca?categorias=area_livre');
assert.ok(r.corpo.itens.some((x) => x.processo === '830.003/2022' && x.livre)); passo('filtro Área Livre (processo que saiu da base, sem sobreposição)');
r = await req('/api/busca?categorias=pedido_lavra,pesquisa_autorizada'); assert.equal(r.corpo.total, 1); passo('combinação OU de filtros');

// 11. Filtro personalizado e grupos minerários
r = await req('/api/filtros', json({ nome: 'Lavra com evento B', regra: { fase: 'LAVRA', evento: 'EVENTO B' }, parametros: { substancia: 'ouro' } }));
const idFiltro = r.corpo.id;
r = await req('/api/busca?categorias=' + idFiltro); assert.equal(r.corpo.total, 1);
r = await req('/api/filtros', json({ nome: 'ruim', regra: { fase: '(' } })); assert.equal(r.status, 400); passo('filtro personalizado (e rejeita regex inválida)');
r = await req('/api/grupos', json({ nome: 'Cliente X' }));
const idGrupo = r.corpo.id;
await req('/api/grupos', json({ id: idGrupo, processo: '830.001/2020' }, 'PUT'));
r = await req('/api/busca?grupo=' + idGrupo); assert.equal(r.corpo.total, 1);
r = await req('/api/processo?id=' + encodeURIComponent('830.001/2020')); assert.equal(r.corpo.grupos[0].nome, 'Cliente X'); passo('grupos minerários');

// 12. CFEM -> minas ativas
const ano = new Date().getFullYear();
r = await req('/api/cfem?arquivo=cfem.csv', { method: 'POST', body: `Ano;Mês;Processo;AnoDoProcesso;Substância;UF;Município;ValorRecolhido\n${ano};1;830001;2020;OURO;MG;CIDADE;1.234,56\n2001;1;830002;2021;FERRO;MG;CIDADE;10,00` });
assert.equal(r.corpo.processos, 2); assert.equal(r.corpo.ativos_na_base, 1);
r = await req('/api/busca?categorias=minas_cfem'); assert.equal(r.corpo.itens[0].processo, '830.001/2020');
r = await req('/api/processo?id=' + encodeURIComponent('830.001/2020')); assert.equal(r.corpo.cfem.valor, 1234.56); passo('CFEM e minas ativas');

// 13. Catálogo: resolução automática contra servidores WMS e ArcGIS simulados
const http = await import('node:http');
const mock = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/wms' && /GetCapabilities/i.test(u.searchParams.get('request'))) {
    s.setHeader('Content-Type', 'text/xml');
    return s.end(`<WMS_Capabilities><Capability><Layer><Title>raiz</Title><Layer queryable="1"><Name>geosgb:litoestratigrafia_1000000_v2</Name><Title>Geologia 1M</Title></Layer><Layer><Name>geosgb:afloramentos</Name><Title>Afloramentos</Title></Layer></Layer></Capability></WMS_Capabilities>`);
  }
  if (u.pathname === '/wms' && /GetFeatureInfo/i.test(u.searchParams.get('request'))) {
    s.setHeader('Content-Type', 'application/json');
    return s.end(JSON.stringify({ features: [{ id: 'lito.1', properties: { SIGLA: 'PP1', NOME: 'Unidade teste' } }] }));
  }
  if (u.pathname === '/arcgis/MapServer') { s.setHeader('Content-Type', 'application/json'); return s.end(JSON.stringify({ layers: [{ id: 0, name: 'Bahia - 1:1.000.000' }, { id: 1, name: 'Goiás - 1:500.000 [2008]' }, { id: 2, name: 'Pará - 1:350.000' }] })); }
  if (u.pathname === '/arcgis/MapServer/identify') { s.setHeader('Content-Type', 'application/json'); return s.end(JSON.stringify({ results: [{ layerName: 'Goiás - 1:500.000 [2008]', attributes: { SIGLA: 'X' } }] })); }
  s.statusCode = 404; s.end('{}');
});
await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
const M = `http://127.0.0.1:${mock.address().port}`;
r = await req('/api/catalogo'); assert.ok(r.corpo.camadas.length >= 20);
r = await req('/api/catalogo', json({ id: 'geologia_1m', url: M + '/wms', camada: 'geosgb:nao_existe' }, 'PUT'));
assert.equal(r.corpo.status, 'nao_encontrada');
r = await req('/api/catalogo', json({ id: 'geologia_1m', url: M + '/wms', camada: 'geosgb:litoestratigrafia_1000000_v2' }, 'PUT'));
assert.equal(r.corpo.status, 'ok');
r = await req('/api/catalogo/consultar', json({ ids: ['geologia_1m'], lat: -20, lng: -44, bbox: '-45,-21,-43,-19', largura: 800, altura: 600, x: 400, y: 300 }));
assert.equal(r.corpo[0].itens[0].atributos.NOME, 'Unidade teste'); passo('WMS: verificação, nome manual e consulta de atributos');
r = await req('/api/catalogo', json({ id: 'geologia_500k', url: M + '/arcgis/MapServer' }, 'PUT'));
assert.equal(r.corpo.status, 'ok'); assert.deepEqual(r.corpo.camadas, [1]);
r = await req('/api/catalogo', json({ id: 'geologia_350k', url: M + '/arcgis/MapServer' }, 'PUT'));
assert.deepEqual(r.corpo.camadas, [2]);
r = await req('/api/catalogo/consultar', json({ ids: ['geologia_500k'], lat: -15, lng: -49, bbox: '-50,-16,-48,-14', largura: 800, altura: 600, x: 400, y: 300 }));
assert.equal(r.corpo[0].itens[0].atributos.SIGLA, 'X'); passo('ArcGIS: seleção de subcamadas por escala e identify');
// Resolução automática (sem nome manual): restaura e aponta só a URL
const { resolver } = await import('../lib/geoservicos.js');
const auto = await resolver({ tipo: 'wms', url: M + '/wms', camada: 'geosgb:litoestratigrafia_1m', busca: 'litoestratigrafia_?1(m|000000)' });
assert.equal(auto.status, 'ok'); assert.equal(auto.camada, 'geosgb:litoestratigrafia_1000000_v2'); passo('auto-resolução de nome de camada WMS');
const fora = await resolver({ tipo: 'wms', url: 'http://127.0.0.1:1/wms', camada: 'x' });
assert.equal(fora.status, 'erro'); passo('serviço fora do ar é reportado como erro');
mock.close();

// 14. Geofísica + GeoAnálise (offline)
r = await req('/api/geofisica/exemplo', json({ lon: -44, lat: -20 }));
assert.ok(r.corpo.canais.mag.pontos > 10000 && r.corpo.canais.k);
const xyz = `/ X Y MAGIGRF KPERC ETH EU\nLine 10\n${Array.from({ length: 400 }, (_, i) => `${600000 + (i % 20) * 50} ${7780000 + Math.floor(i / 20) * 50} ${Math.sin(i) * 10} 1.2 8 2`).join('\n')}`;
r = await req('/api/geofisica?arquivo=t.xyz&nome=utm', { method: 'POST', body: xyz });
assert.equal(r.status, 400); assert.match(r.corpo.erro, /zona UTM/);
r = await req('/api/geofisica?arquivo=t.xyz&nome=utm&zona=23', { method: 'POST', body: xyz });
assert.equal(r.corpo.canais.mag.pontos, 400); passo('importação de levantamento XYZ (UTM exige zona)');
r = await req('/api/geoanalise', json({ geometria: quad(-44.02, -20.02, 0.04), nome: 'Teste GA', online: false, raioKm: 5 }));
const idGa = r.corpo.id;
let st;
for (let i = 0; i < 60; i++) { st = (await req('/api/geoanalise/status?id=' + idGa)).corpo; if (st.status !== 'executando') break; await new Promise((ok) => setTimeout(ok, 500)); }
assert.equal(st.status, 'concluida', JSON.stringify(st));
r = await req('/api/geoanalise/resultado?id=' + idGa);
assert.equal(r.corpo.geofisica.produtos.length, 27);
assert.ok(r.corpo.geofisica.anomalias.length >= 3);
const rel = await req(`/api/geoanalise/arquivo?id=${idGa}&f=relatorio.html`);
assert.ok(String(rel.corpo).includes('Teste GA') && String(rel.corpo).includes('data:image/png;base64'));
const zip = await fetch(`${URL_BASE}/api/geoanalise/arquivo?id=${idGa}&f=pacote.zip&baixar=1`);
const AdmZip = (await import('adm-zip')).default;
const nomes = new AdmZip(Buffer.from(await zip.arrayBuffer())).getEntries().map((e) => e.entryName);
assert.ok(nomes.includes('geofisica/grades/mag_asa.asc') && nomes.includes('geofisica.kmz') && nomes.includes('relatorio.html'));
r = await req(`/api/geoanalise/arquivo?id=${idGa}&f=../../estado.json`); assert.equal(r.status, 400);
passo('GeoAnálise: 27 produtos geofísicos, relatório, pacote GIS e bloqueio de caminhos');
r = await req('/api/geoanalise'); assert.equal(r.corpo[0].id, idGa);
r = await req('/api/anm/processo?id=abc'); assert.equal(r.status, 400); passo('lista de análises e validação de processo');

// 15. GeoAnálise online contra serviços simulados (WFS + ArcGIS query)
const mock2 = http.createServer(async (q, s) => {
  const u = new URL(q.url, 'http://x');
  s.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/ows' && u.searchParams.get('service') === 'WFS') {
    return s.end(JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { SIGLA: 'PP2gr', NOME: 'Granito Teste', LITOTIPOS: 'Granito' }, geometry: { type: 'Polygon', coordinates: [[[-44.1, -20.1], [-44.0, -20.1], [-44.0, -19.9], [-44.1, -19.9], [-44.1, -20.1]]] } },
      { type: 'Feature', properties: { SIGLA: 'A3x', NOME: 'Xisto Teste' }, geometry: { type: 'Polygon', coordinates: [[[-44.0, -20.1], [-43.9, -20.1], [-43.9, -19.9], [-44.0, -19.9], [-44.0, -20.1]]] } },
    ] }));
  }
  if (u.pathname === '/wms') return s.end('<WMS_Capabilities><Layer><Name>geosgb:lito</Name></Layer></WMS_Capabilities>');
  if (u.pathname === '/arc/MapServer') return s.end(JSON.stringify({ layers: [{ id: 0, name: 'ocorrencias' }] }));
  if (u.pathname === '/arc/MapServer/0/query') {
    return s.end(JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { SUBSTANCIA: 'OURO', TOPONIMIA: 'Ocorrência A' }, geometry: { type: 'Point', coordinates: [-44.0, -20.0] } },
      { type: 'Feature', properties: { SUBSTANCIA: 'FERRO' }, geometry: { type: 'Point', coordinates: [-43.9, -20.0] } },
    ] }));
  }
  s.statusCode = 404; s.end('{}');
});
await new Promise((ok) => mock2.listen(0, '127.0.0.1', ok));
const M2 = `http://127.0.0.1:${mock2.address().port}`;
await req('/api/catalogo', json({ id: 'geologia_1m', url: M2 + '/wms', camada: 'geosgb:lito' }, 'PUT'));
await req('/api/catalogo', json({ id: 'ocorrencias_sgb', url: M2 + '/arc/MapServer', camadas: [0] }, 'PUT'));
r = await req('/api/geoanalise', json({ geometria: quad(-44.02, -20.02, 0.04), online: true, raioKm: 15, substanciaAlvo: 'ouro', geofisica: false }));
const idGa2 = r.corpo.id;
for (let i = 0; i < 120; i++) { st = (await req('/api/geoanalise/status?id=' + idGa2)).corpo; if (st.status !== 'executando') break; await new Promise((ok) => setTimeout(ok, 500)); }
assert.equal(st.status, 'concluida', JSON.stringify(st));
r = await req('/api/geoanalise/resultado?id=' + idGa2);
const lito = r.corpo.litologia_1m.itens;
assert.equal(lito.length, 2); assert.ok(Math.abs(lito[0].perc + lito[1].perc - 100) < 1, JSON.stringify(lito));
assert.equal(r.corpo.ocorrencias.total, 2); assert.equal(r.corpo.ocorrencias.intersecta, 1);
assert.ok(r.corpo.sintese.favoravel.some((t) => /citam ouro/.test(t)), JSON.stringify(r.corpo.sintese));
passo('GeoAnálise online: % de litologia na área, ocorrências e síntese por substância');
mock2.close();

// 16. Localização de serviço ArcGIS por nome em subpastas (camadas sem endereço fixo)
const mock3 = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  s.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/rest/services') return s.end(JSON.stringify({ folders: ['basegeo', 'geofisica'], services: [] }));
  if (u.pathname === '/rest/services/basegeo') return s.end(JSON.stringify({ services: [{ name: 'basegeo/limites', type: 'MapServer' }] }));
  if (u.pathname === '/rest/services/geofisica') return s.end(JSON.stringify({ services: [{ name: 'geofisica/Projetos_Aerogeofisicos', type: 'MapServer' }] }));
  if (u.pathname === '/rest/services/geofisica/Projetos_Aerogeofisicos/MapServer') return s.end(JSON.stringify({ layers: [{ id: 0, name: 'Projetos' }] }));
  s.statusCode = 404; s.end('{}');
});
await new Promise((ok) => mock3.listen(0, '127.0.0.1', ok));
const M3 = `http://127.0.0.1:${mock3.address().port}/rest/services`;
const achado = await resolver({ tipo: 'arcgis', url: '', camadas: [], pasta: M3, buscaServico: 'aerogeof|^aero' });
assert.equal(achado.status, 'ok'); assert.equal(achado.url, `${M3}/geofisica/Projetos_Aerogeofisicos/MapServer`);
passo('busca automática de serviço ArcGIS em subpastas');
mock3.close();

servidor.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${ok} verificações passaram.`);
