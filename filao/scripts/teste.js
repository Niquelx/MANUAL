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

servidor.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${ok} verificações passaram.`);
