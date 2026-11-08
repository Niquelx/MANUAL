/* Filão: interface. Leaflet + Geoman. */
(() => {
'use strict';

// ---------- Utilitários ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
const dataBR = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '');
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
async function api(url, opt = {}) {
  const r = await fetch(url, opt);
  const tipo = r.headers.get('content-type') || '';
  const dados = tipo.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(dados.erro || `Erro ${r.status}`);
  return dados;
}
const post = (url, corpo, metodo = 'POST') => api(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });

// Cores por fase (palavras-chave, para tolerar variações de nome)
const CORES_FASE = [
  ['CONCESSÃO DE LAVRA', '#c92a2a'], ['REQUERIMENTO DE LAVRA GARIMPEIRA', '#ffa94d'], ['LAVRA GARIMPEIRA', '#e8590c'],
  ['REQUERIMENTO DE LAVRA', '#f783ac'], ['AUTORIZAÇÃO DE PESQUISA', '#1c7ed6'], ['REQUERIMENTO DE PESQUISA', '#74c0fc'],
  ['REQUERIMENTO DE LICENCIAMENTO', '#b2f2bb'], ['LICENCIAMENTO', '#2f9e44'], ['REGISTRO DE EXTRAÇÃO', '#9c36b5'],
  ['REQUERIMENTO DE REGISTRO DE EXTRAÇÃO', '#da77f2'], ['DIREITO DE REQUERER A LAVRA', '#862e9c'], ['DISPONIBILIDADE', '#868e96'],
  ['APTO PARA DISPONIBILIDADE', '#495057'], ['MINERAIS', '#5c940d'],
];
function corFase(f) {
  const s = String(f || '').toUpperCase();
  for (const [k, c] of CORES_FASE) if (s === k) return c;
  for (const [k, c] of CORES_FASE) if (s.includes(k)) return c;
  return '#adb5bd';
}
const tagFase = (f) => `<span class="tag" style="background:${corFase(f)}">${esc(f || 'n/d')}</span>`;

// ---------- Mapa ----------
const mapa = L.map('mapa', { zoomControl: true, preferCanvas: true }).setView([-15.8, -47.9], 5);
const bases = {
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
  'Satélite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' }),
  'Topográfico (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' }),
  'Claro (Carto)': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '© OpenStreetMap, © CARTO' }),
};
let baseAtual = bases['OpenStreetMap'].addTo(mapa);
L.control.scale({ imperial: false }).addTo(mapa);
mapa.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawText: false, drawCircle: false, cutPolygon: false, rotateMode: false });
mapa.pm.setLang('pt_br');

mapa.on('mousemove', (e) => { $('#coords').textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`; });

const camadaProcessos = L.geoJSON(null, {
  style: (f) => ({ color: corFase(f.properties.fase), weight: 1.2, fillOpacity: 0.25 }),
  onEachFeature: (f, l) => {
    l.bindTooltip(`<b>${esc(f.properties.processo)}</b><br>${esc(f.properties.fase)}<br>${esc(f.properties.substancia)}<br>${esc(f.properties.titular)}`, { sticky: true });
    l.on('click', () => abrirProcesso(f.properties.processo));
  },
}).addTo(mapa);
const camadaDestaque = L.geoJSON(null, { style: { color: '#fab005', weight: 3, fillOpacity: 0.05 } }).addTo(mapa);
const camadaAnalise = L.featureGroup().addTo(mapa);
const camadaRegioes = L.featureGroup().addTo(mapa);
const camadasUsuario = new Map();

let filtrosAtuais = {};
let pedidoMapa = 0;
async function atualizarMapa() {
  if (!$('#cam-processos').checked) { camadaProcessos.clearLayers(); $('#mapa-aviso').hidden = true; return; }
  if (mapa.getZoom() < 8) {
    camadaProcessos.clearLayers();
    aviso('Aproxime o mapa (zoom 8+) para ver os polígonos dos processos.');
    return;
  }
  const b = mapa.getBounds();
  const p = new URLSearchParams({ ...limparFiltros(filtrosAtuais), bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',') });
  const id = ++pedidoMapa;
  try {
    const fc = await api('/api/mapa?' + p);
    if (id !== pedidoMapa) return;
    camadaProcessos.clearLayers().addData(fc);
    aviso(fc.truncado ? `Mostrando ${fmt(fc.features.length, 0)} de ${fmt(fc.total, 0)} processos. Aproxime para ver todos.` : '');
  } catch (e) { aviso('Erro ao carregar processos: ' + e.message); }
}
function aviso(txt) { const a = $('#mapa-aviso'); a.textContent = txt; a.hidden = !txt; }
let tMapa;
mapa.on('moveend', () => { clearTimeout(tMapa); tMapa = setTimeout(atualizarMapa, 250); });

function destacar(feature, zoom = true) {
  camadaDestaque.clearLayers().addData(feature);
  if (zoom) mapa.fitBounds(camadaDestaque.getBounds(), { maxZoom: 14, padding: [40, 40] });
}
function irBbox(bb) { mapa.fitBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { maxZoom: 14, padding: [40, 40] }); }

// ---------- Abas ----------
$('#abas').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-aba]'); if (!b) return;
  mostrarAba(b.dataset.aba);
});
function mostrarAba(nome) {
  $$('#abas button').forEach((x) => x.classList.toggle('ativa', x.dataset.aba === nome));
  $$('.painel').forEach((x) => x.classList.toggle('ativo', x.dataset.painel === nome));
  ({ monitorados: carregarMonitorados, alertas: carregarAlertas, regioes: carregarRegioes, painel: carregarPainel, dados: carregarDados, camadas: carregarCamadas })[nome]?.();
}

// ---------- Busca ----------
const form = $('#form-busca');
let inicio = 0;
const LIMITE = 50;
function lerFiltros() {
  const d = Object.fromEntries(new FormData(form));
  if (d.na_tela) { const b = mapa.getBounds(); d.bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','); }
  delete d.na_tela;
  return d;
}
function limparFiltros(f) {
  const o = {}; for (const [k, v] of Object.entries(f)) if (v !== '' && v != null && k !== 'bbox' && k !== 'ordem' && k !== 'dir') o[k] = v; return o;
}
async function buscar(novoInicio = 0) {
  inicio = novoInicio;
  filtrosAtuais = lerFiltros();
  const p = new URLSearchParams({ ...Object.fromEntries(Object.entries(filtrosAtuais).filter(([, v]) => v !== '')), inicio, limite: LIMITE });
  $('#resultados').classList.add('carregando');
  try {
    const r = await api('/api/busca?' + p);
    $('#resultado-info').textContent = `${fmt(r.total, 0)} processo(s) · ${fmt(r.facetas.area_total_ha, 0)} ha no total`;
    $('#resultados').innerHTML = r.itens.map(itemProcesso).join('') || '<li class="sub">Nenhum resultado.</li>';
    $('#facetas').innerHTML = r.facetas.fase.slice(0, 8).map((x) => `<button class="chip" data-fase="${esc(x.valor)}" style="border-color:${corFase(x.valor)}">${esc(x.valor)} (${fmt(x.qtd, 0)})</button>`).join('');
    const pag = $('#paginacao');
    pag.innerHTML = `${inicio > 0 ? '<button data-p="-1">← Anterior</button>' : '<span></span>'}<span class="info">${r.total ? `${inicio + 1}–${Math.min(inicio + LIMITE, r.total)}` : ''}</span>${inicio + LIMITE < r.total ? '<button data-p="1">Próxima →</button>' : '<span></span>'}`;
  } catch (e) { toast(e.message); }
  $('#resultados').classList.remove('carregando');
  atualizarMapa();
}
function itemProcesso(p) {
  return `<li data-id="${esc(p.processo)}" data-bbox="${p.bbox ? p.bbox.join(',') : ''}">
    <div class="tit"><span>${esc(p.processo)}</span>${tagFase(p.fase)}</div>
    <div class="sub">${esc(p.titular)}</div>
    <div class="sub">${esc(p.substancia)} · ${fmt(p.area_ha)} ha · ${esc(p.uf)}${p.uso ? ' · ' + esc(p.uso) : ''}</div>
    <div class="sub">${esc(p.ult_evento)}</div></li>`;
}
form.addEventListener('submit', (e) => { e.preventDefault(); buscar(0); });
form.addEventListener('reset', () => setTimeout(() => buscar(0), 0));
$('#paginacao').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) buscar(inicio + Number(b.dataset.p) * LIMITE); });
$('#facetas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fase]'); if (!b) return;
  $('#sel-fase').value = b.dataset.fase; buscar(0);
});
document.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li && !e.target.closest('button')) {
    if (li.dataset.bbox) irBbox(li.dataset.bbox.split(',').map(Number));
    abrirProcesso(li.dataset.id);
  }
});

// Exportação
$('#btn-exportar').addEventListener('click', () => { const m = $('.menu-export .menu'); m.hidden = !m.hidden; });
$$('.menu-export a').forEach((a) => a.addEventListener('click', () => {
  $('.menu-export .menu').hidden = true;
  const f = Object.fromEntries(Object.entries(lerFiltros()).filter(([, v]) => v !== ''));
  location.href = '/api/exportar?' + new URLSearchParams({ ...f, formato: a.dataset.fmt });
}));

// ---------- Detalhe do processo ----------
async function abrirProcesso(id) {
  try {
    const d = await api('/api/processo?id=' + encodeURIComponent(id));
    const p = d.feature.properties;
    destacar(d.feature, false);
    $('#detalhe-corpo').innerHTML = `
      <h2 style="margin:0 0 6px">${esc(p.processo)}</h2>
      <div>${tagFase(p.fase)}</div>
      <table>
        <tr><td>Titular</td><td>${esc(p.titular)}</td></tr>
        <tr><td>Substância</td><td>${esc(p.substancia)}</td></tr>
        <tr><td>Uso</td><td>${esc(p.uso)}</td></tr>
        <tr><td>Área</td><td>${fmt(p.area_ha)} ha</td></tr>
        <tr><td>UF</td><td>${esc(p.uf)}</td></tr>
        <tr><td>Ano</td><td>${esc(p.ano)}</td></tr>
        <tr><td>Último evento</td><td>${esc(p.ult_evento)}</td></tr>
        <tr><td>Centroide</td><td>${centroTxt(d.feature.bbox)}</td></tr>
      </table>
      <div class="linha acoes">
        <button id="det-zoom">Ver no mapa</button>
        <button id="det-mon" class="${d.monitorado ? '' : 'primario'}">${d.monitorado ? 'Parar de monitorar' : 'Monitorar'}</button>
        <button id="det-int">Analisar interferências</button>
        <button id="det-kml">KML</button>
        <button id="det-geo">GeoJSON</button>
        ${d.link_externo ? `<a class="botao" target="_blank" rel="noopener" href="${esc(d.link_externo)}">Consulta externa ↗</a>` : ''}
      </div>
      ${d.monitorado ? `<label class="form">Anotações<textarea id="det-nota" rows="3">${esc(d.monitorado.nota)}</textarea></label><button id="det-salvar-nota">Salvar anotação</button>` : ''}
      <h3>Histórico de alterações (detectadas nas importações)</h3>
      <div class="linha-tempo">${d.historico.length ? d.historico.slice().reverse().map((h) => `<div><b>${dataBR(h.data)}</b><br>${esc(h.campo)}: ${esc(h.de)} → ${esc(h.para)}</div>`).join('') : '<div class="sub">Sem alterações registradas.</div>'}</div>
      <h3>Processos no entorno (${d.vizinhos.length})</h3>
      <ul class="lista">${d.vizinhos.map(itemProcesso).join('')}</ul>`;
    $('#detalhe').hidden = false;
    $('#det-zoom').onclick = () => destacar(d.feature);
    $('#det-mon').onclick = async () => {
      if (d.monitorado) await api('/api/monitorados?id=' + encodeURIComponent(id), { method: 'DELETE' });
      else await post('/api/monitorados', { processo: id });
      toast(d.monitorado ? 'Monitoramento removido.' : 'Processo monitorado.');
      abrirProcesso(id); atualizarBadge();
    };
    $('#det-int').onclick = () => { mostrarAba('analise'); analisar(d.feature.geometry); };
    $('#det-kml').onclick = () => baixarIds([id], 'kml');
    $('#det-geo').onclick = () => baixarIds([id], 'geojson');
    if (d.monitorado) $('#det-salvar-nota').onclick = async () => { await post('/api/monitorados', { processo: id, nota: $('#det-nota').value }); toast('Anotação salva.'); };
  } catch (e) { toast(e.message); }
}
function centroTxt(bb) { return bb ? `${((bb[1] + bb[3]) / 2).toFixed(5)}, ${((bb[0] + bb[2]) / 2).toFixed(5)}` : ''; }
async function baixarIds(ids, formato) {
  const r = await fetch('/api/exportar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, formato }) });
  const blob = await r.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${ids.length === 1 ? ids[0].replace(/\W/g, '_') : 'processos'}.${formato}`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#fechar-detalhe').onclick = () => { $('#detalhe').hidden = true; camadaDestaque.clearLayers(); };

// ---------- Desenho (análise e regiões) ----------
let modoDesenho = 'analise';
function iniciarDesenho(modo, forma = 'Polygon') { modoDesenho = modo; mapa.pm.enableDraw(forma, { snappable: true }); toast('Clique no mapa para desenhar. Clique no primeiro ponto para fechar.'); }
$('#btn-desenhar').onclick = () => iniciarDesenho('analise', 'Polygon');
$('#btn-retangulo').onclick = () => iniciarDesenho('analise', 'Rectangle');
$('#btn-nova-regiao').onclick = () => iniciarDesenho('regiao', 'Polygon');
mapa.on('pm:create', async (e) => {
  const geo = e.layer.toGeoJSON().geometry;
  mapa.removeLayer(e.layer);
  if (modoDesenho === 'regiao') {
    const nome = $('#nome-regiao').value.trim() || prompt('Nome da região:') || 'Região';
    await post('/api/regioes', { nome, geometria: geo });
    $('#nome-regiao').value = ''; modoDesenho = 'analise';
    toast('Região salva.'); carregarRegioes();
  } else {
    mostrarAba('analise'); analisar(geo);
  }
});

async function analisar(geometria) {
  camadaAnalise.clearLayers();
  L.geoJSON(geometria, { style: { color: '#000', weight: 2, dashArray: '6 4', fill: false } }).addTo(camadaAnalise);
  mapa.fitBounds(camadaAnalise.getBounds(), { padding: [40, 40] });
  $('#analise-res').innerHTML = '<p class="info">Calculando…</p>';
  try {
    const r = await post('/api/interferencia', { geometria });
    if (r.geometria_livre) L.geoJSON(r.geometria_livre, { style: { color: '#2f9e44', weight: 1, fillOpacity: 0.35 } }).addTo(camadaAnalise);
    if (r.geometria_ocupada) L.geoJSON(r.geometria_ocupada, { style: { color: '#c92a2a', weight: 1, fillOpacity: 0.35 } }).addTo(camadaAnalise);
    analisar.ultimo = { geometria, r };
    $('#analise-res').innerHTML = `
      <div class="numeros">
        <div><small>Área desenhada</small><b>${fmt(r.area_alvo_ha)} ha</b></div>
        <div><small>Perímetro</small><b>${fmt(r.perimetro_km)} km</b></div>
        <div><small>Área ocupada</small><b style="color:#c92a2a">${fmt(r.area_ocupada_ha)} ha</b></div>
        <div><small>Área livre</small><b style="color:#2f9e44">${fmt(r.area_livre_ha)} ha (${fmt(r.perc_livre)}%)</b></div>
      </div>
      <p class="dica">Centroide: ${r.centroide[1].toFixed(6)}, ${r.centroide[0].toFixed(6)}. A área livre considera apenas a base importada localmente; confirme a disponibilidade junto à ANM antes de protocolar.</p>
      <div class="linha acoes">
        <button id="an-livre-kml">Baixar área livre (KML)</button>
        <button id="an-livre-geo">Área livre (GeoJSON)</button>
        <button id="an-int-csv">Interferências (CSV)</button>
        <button id="an-regiao">Salvar como região monitorada</button>
        <button id="an-limpar">Limpar</button>
      </div>
      <h3>Interferências (${r.interferencias.length})</h3>
      <table class="tabela-int"><tr><th>Processo</th><th>Fase</th><th>Sobrep. (ha)</th><th>% alvo</th></tr>
      ${r.interferencias.map((i) => `<tr data-proc="${esc(i.processo)}"><td>${esc(i.processo)}<br><small>${esc(i.titular)}</small></td><td>${tagFase(i.fase)}</td><td>${fmt(i.area_sobreposta_ha)}</td><td>${fmt(i.perc_do_alvo)}%</td></tr>`).join('')}</table>`;
    $$('#analise-res tr[data-proc]').forEach((tr) => (tr.onclick = () => abrirProcesso(tr.dataset.proc)));
    $('#an-limpar').onclick = () => { camadaAnalise.clearLayers(); $('#analise-res').innerHTML = ''; };
    $('#an-livre-kml').onclick = () => baixarTexto('area-livre.kml', geoParaKml(r.geometria_livre, 'Área livre'), 'application/vnd.google-earth.kml+xml');
    $('#an-livre-geo').onclick = () => baixarTexto('area-livre.geojson', JSON.stringify(r.geometria_livre), 'application/geo+json');
    $('#an-int-csv').onclick = () => baixarIds(r.interferencias.map((i) => i.processo), 'csv');
    $('#an-regiao').onclick = async () => { const nome = prompt('Nome da região:', 'Área analisada'); if (!nome) return; await post('/api/regioes', { nome, geometria }); toast('Região salva.'); };
  } catch (e) { $('#analise-res').innerHTML = `<p class="info">${esc(e.message)}</p>`; }
}
function baixarTexto(nome, texto, tipo) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([texto], { type: tipo })); a.download = nome; a.click();
}
function geoParaKml(feat, nome) {
  if (!feat) return '';
  const g = feat.geometry || feat;
  const anel = (r) => `<LinearRing><coordinates>${r.map((c) => c[0] + ',' + c[1] + ',0').join(' ')}</coordinates></LinearRing>`;
  const pol = (p) => `<Polygon><outerBoundaryIs>${anel(p[0])}</outerBoundaryIs>${p.slice(1).map((r) => `<innerBoundaryIs>${anel(r)}</innerBoundaryIs>`).join('')}</Polygon>`;
  const corpo = g.type === 'Polygon' ? pol(g.coordinates) : `<MultiGeometry>${g.coordinates.map(pol).join('')}</MultiGeometry>`;
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>${esc(nome)}</name>${corpo}</Placemark></Document></kml>`;
}

// Coordenadas coladas (decimal ou GMS)
function parseCoord(txt) {
  txt = txt.trim().toUpperCase();
  const gms = [...txt.matchAll(/(\d+)[°º\s]+(\d+)['’\s]+([\d.,]+)["”]?\s*([NSEWOL])/g)];
  if (gms.length >= 2) {
    const conv = (m) => { let v = +m[1] + +m[2] / 60 + parseFloat(m[3].replace(',', '.')) / 3600; if ('SWO'.includes(m[4])) v = -v; return { v, h: m[4] }; };
    const a = conv(gms[0]), b = conv(gms[1]);
    return 'NS'.includes(a.h) ? [b.v, a.v] : [a.v, b.v];
  }
  const nums = txt.replace(/;/g, ' ').match(/-?\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const lat = parseFloat(nums[0].replace(',', '.')), lon = parseFloat(nums[1].replace(',', '.'));
  return [lon, lat];
}
$('#btn-coords').onclick = () => {
  const pts = $('#txt-coords').value.split('\n').map(parseCoord).filter(Boolean);
  if (pts.length < 3) return toast('Informe ao menos 3 vértices.');
  if (pts[0][0] !== pts.at(-1)[0] || pts[0][1] !== pts.at(-1)[1]) pts.push(pts[0]);
  analisar({ type: 'Polygon', coordinates: [pts] });
};
$('#arq-analise').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const meta = await api(`/api/camadas?nome=${encodeURIComponent('Análise: ' + f.name)}&grupo=An%C3%A1lises&arquivo=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    const fc = await api('/api/camada?id=' + meta.id);
    const pol = fc.features.find((x) => /Polygon/.test(x.geometry.type));
    if (!pol) return toast('Arquivo sem polígono.');
    analisar(pol.geometry);
  } catch (err) { toast(err.message); }
  e.target.value = '';
};

// ---------- Monitorados ----------
async function carregarMonitorados() {
  const lista = await api('/api/monitorados');
  const filtro = $('#filtro-mon').value.toLowerCase();
  $('#lista-mon').innerHTML = lista.filter((m) => !filtro || JSON.stringify(m).toLowerCase().includes(filtro)).map((m) => {
    const p = m.atual || { processo: m.processo };
    return `<li data-id="${esc(m.processo)}" data-bbox="${p.bbox ? p.bbox.join(',') : ''}">
      <div class="tit"><span>${esc(m.processo)} ${m.alertas_nao_lidos ? `<span class="badge">${m.alertas_nao_lidos}</span>` : ''}</span>${m.atual ? tagFase(p.fase) : '<span class="tag" style="background:#868e96">fora da base</span>'}</div>
      <div class="sub">${esc(p.titular || '')} · ${esc(p.substancia || '')}</div>
      <div class="sub">${esc(p.ult_evento || '')}</div>
      ${m.nota ? `<div class="sub">📝 ${esc(m.nota)}</div>` : ''}
      <div class="sub">Monitorado desde ${dataBR(m.desde)}</div>
      <div class="acoes-item"><button data-rm="${esc(m.processo)}">Remover</button></div></li>`;
  }).join('') || '<li class="sub">Nenhum processo monitorado. Abra um processo e clique em "Monitorar".</li>';
}
$('#filtro-mon').oninput = carregarMonitorados;
$('#lista-mon').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  await api('/api/monitorados?id=' + encodeURIComponent(b.dataset.rm), { method: 'DELETE' });
  carregarMonitorados();
});

// ---------- Alertas ----------
const ROTULO_ALERTA = { alteracao: 'Alteração', removido: 'Saiu da base', regiao: 'Nova área na região' };
async function carregarAlertas() {
  const lista = await api('/api/alertas' + ($('#so-nao-lidos').checked ? '?nao_lidos=1' : ''));
  $('#lista-alertas').innerHTML = lista.map((a) => `
    <li data-id="${esc(a.processo)}" class="${a.lido ? '' : 'nao-lido'}">
      <div class="tit"><span>${esc(a.processo)}</span><span class="tag" style="background:${a.tipo === 'regiao' ? '#1c7ed6' : a.tipo === 'removido' ? '#868e96' : '#d9480f'}">${ROTULO_ALERTA[a.tipo] || a.tipo}</span></div>
      <div class="sub">${esc(a.mensagem)}</div>
      <div class="sub">${dataBR(a.data)}</div>
      <div class="acoes-item"><button data-lido="${a.id}" data-v="${!a.lido}">${a.lido ? 'Marcar não lido' : 'Marcar lido'}</button><button data-del="${a.id}">Excluir</button></div>
    </li>`).join('') || '<li class="sub">Sem alertas.</li>';
  atualizarBadge();
}
$('#lista-alertas').addEventListener('click', async (e) => {
  const l = e.target.closest('[data-lido]'), d = e.target.closest('[data-del]');
  if (l) await post('/api/alertas', { ids: [l.dataset.lido], lido: l.dataset.v === 'true' });
  if (d) await api('/api/alertas?id=' + d.dataset.del, { method: 'DELETE' });
  if (l || d) carregarAlertas();
});
$('#so-nao-lidos').onchange = carregarAlertas;
$('#btn-ler-todos').onclick = async () => { await post('/api/alertas', { todos: true }); carregarAlertas(); };
$('#btn-limpar-lidos').onclick = async () => { await api('/api/alertas', { method: 'DELETE' }); carregarAlertas(); };
$('#btn-notif').onclick = async () => { if ('Notification' in window) { const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Notificações ativadas.' : 'Permissão negada.'); } };
let ultimosNaoLidos = null;
async function atualizarBadge() {
  try {
    const r = await api('/api/alertas?nao_lidos=1&limite=1000');
    const b = $('#badge-alertas'); b.textContent = r.length; b.hidden = !r.length;
    if (ultimosNaoLidos !== null && r.length > ultimosNaoLidos && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Filão: novos alertas', { body: `${r.length - ultimosNaoLidos} novo(s) alerta(s) de processos.` });
    }
    ultimosNaoLidos = r.length;
  } catch { /* servidor fora */ }
}
setInterval(atualizarBadge, 60000);

// ---------- Regiões ----------
async function carregarRegioes() {
  const lista = await api('/api/regioes');
  camadaRegioes.clearLayers();
  for (const r of lista) L.geoJSON(r.geometry, { style: { color: '#1c7ed6', weight: 2, dashArray: '4 4', fillOpacity: 0.05 } }).bindTooltip(esc(r.nome)).addTo(camadaRegioes);
  $('#lista-regioes').innerHTML = lista.map((r) => `
    <li data-reg="${r.id}"><div class="tit"><span>${esc(r.nome)}</span></div><div class="sub">Criada em ${dataBR(r.criada)}</div>
    <div class="acoes-item"><button data-ver="${r.id}">Ver</button><button data-an="${r.id}">Analisar</button><button data-proc="${r.id}">Processos na região</button><button data-rm="${r.id}">Excluir</button></div></li>`).join('') || '<li class="sub">Nenhuma região.</li>';
  carregarRegioes.lista = lista;
}
$('#lista-regioes').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const reg = carregarRegioes.lista.find((r) => r.id === (b.dataset.ver || b.dataset.an || b.dataset.rm || b.dataset.proc));
  if (b.dataset.ver) mapa.fitBounds(L.geoJSON(reg.geometry).getBounds());
  if (b.dataset.an) { mostrarAba('analise'); analisar(reg.geometry); }
  if (b.dataset.proc) {
    const r = await post('/api/busca', { geometria: reg.geometry, limite: 500 });
    mostrarAba('busca');
    $('#resultado-info').textContent = `${r.total} processo(s) na região "${reg.nome}"`;
    $('#resultados').innerHTML = r.itens.map(itemProcesso).join('');
    $('#paginacao').innerHTML = ''; $('#facetas').innerHTML = '';
    mapa.fitBounds(L.geoJSON(reg.geometry).getBounds());
  }
  if (b.dataset.rm && confirm('Excluir região?')) { await api('/api/regioes?id=' + reg.id, { method: 'DELETE' }); carregarRegioes(); }
});

// ---------- Camadas ----------
function montarBases() {
  $('#bases').innerHTML = Object.keys(bases).map((n) => `<div><label class="check"><input type="radio" name="base" value="${esc(n)}" ${bases[n] === baseAtual ? 'checked' : ''}> ${esc(n)}</label></div>`).join('');
  $('#legenda-fases').innerHTML = CORES_FASE.map(([k, c]) => `<span style="--c:${c}">${esc(k.toLowerCase())}</span>`).join('');
}
$('#bases').addEventListener('change', (e) => { mapa.removeLayer(baseAtual); baseAtual = bases[e.target.value].addTo(mapa); baseAtual.bringToBack(); });
$('#cam-processos').onchange = atualizarMapa;
async function carregarCamadas() {
  const lista = await api('/api/camadas');
  $('#lista-camadas').innerHTML = lista.map((c) => `
    <div><label class="check"><input type="checkbox" data-cam="${c.id}" ${camadasUsuario.has(c.id) ? 'checked' : ''}>
    <span style="display:inline-block;width:12px;height:12px;background:${esc(c.cor)};border-radius:2px"></span> ${esc(c.nome)} <span class="grupo">${esc(c.grupo)} · ${c.total} feições</span></label>
    <button data-zoom="${c.id}" title="Aproximar">⌖</button><button data-rmcam="${c.id}" title="Excluir">×</button></div>`).join('');
  carregarCamadas.lista = lista;
}
async function ligarCamada(id, ligar) {
  if (!ligar) { const l = camadasUsuario.get(id); if (l) mapa.removeLayer(l); camadasUsuario.delete(id); return; }
  const meta = carregarCamadas.lista.find((c) => c.id === id);
  const fc = await api('/api/camada?id=' + id);
  const l = L.geoJSON(fc, {
    style: { color: meta.cor, weight: 1.5, fillOpacity: 0.2 },
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 5, color: meta.cor, fillOpacity: 0.8 }),
    onEachFeature: (f, lyr) => {
      const props = Object.entries(f.properties || {}).slice(0, 15).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(v)}`).join('<br>');
      if (props) lyr.bindPopup(`<div style="max-height:220px;overflow:auto">${props}</div>`);
    },
  }).addTo(mapa);
  camadasUsuario.set(id, l);
  return l;
}
$('#lista-camadas').addEventListener('change', (e) => { if (e.target.dataset.cam) ligarCamada(e.target.dataset.cam, e.target.checked); });
$('#lista-camadas').addEventListener('click', async (e) => {
  const z = e.target.closest('[data-zoom]'), r = e.target.closest('[data-rmcam]');
  if (z) { const l = camadasUsuario.get(z.dataset.zoom) || (await ligarCamada(z.dataset.zoom, true)); mapa.fitBounds(l.getBounds()); carregarCamadas(); }
  if (r && confirm('Excluir camada?')) { ligarCamada(r.dataset.rmcam, false); await api('/api/camadas?id=' + r.dataset.rmcam, { method: 'DELETE' }); carregarCamadas(); }
});
$('#form-camada').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target); const arq = f.get('arquivo');
  const p = new URLSearchParams({ nome: f.get('nome'), grupo: f.get('grupo') || 'Minhas camadas', cor: f.get('cor'), arquivo: arq.name });
  toast('Enviando camada…');
  try { const meta = await api('/api/camadas?' + p, { method: 'POST', body: arq }); toast(`Camada criada com ${meta.total} feições.`); e.target.reset(); await carregarCamadas(); }
  catch (err) { toast(err.message, 6000); }
};

// ---------- Painel ----------
function barras(el, itens, campo) {
  const max = Math.max(1, ...itens.map((i) => i.qtd));
  el.innerHTML = itens.map((i) => `<div class="barra" data-campo="${campo}" data-valor="${esc(i.valor)}" title="${esc(i.valor)}"><span>${esc(i.valor)}</span><i style="width:${(i.qtd / max) * 100}%;${campo === 'fase' ? `background:${corFase(i.valor)}` : ''}"></i><span>${fmt(i.qtd, 0)}</span></div>`).join('');
}
async function carregarPainel() {
  const r = await api('/api/resumo');
  $('#painel-numeros').innerHTML = `
    <div><small>Processos na base</small><b>${fmt(r.total, 0)}</b></div>
    <div><small>Área total</small><b>${fmt(r.facetas.area_total_ha, 0)} ha</b></div>
    <div><small>Monitorados</small><b>${r.monitorados}</b></div>
    <div><small>Alertas não lidos</small><b>${r.alertas_nao_lidos}</b></div>`;
  barras($('#graf-fase'), r.facetas.fase, 'fase');
  barras($('#graf-subs'), r.facetas.substancia.slice(0, 15), 'substancia');
  barras($('#graf-tit'), r.facetas.titular.slice(0, 15), 'titular');
  barras($('#graf-uf'), r.facetas.uf, 'uf');
}
$('[data-painel="painel"]').addEventListener('click', (e) => {
  const b = e.target.closest('.barra'); if (!b) return;
  form.reset();
  const campo = b.dataset.campo, valor = b.dataset.valor;
  if (campo === 'fase') $('#sel-fase').value = valor; else if (campo === 'uf') $('#sel-uf').value = valor; else form.elements[campo].value = valor;
  mostrarAba('busca'); setTimeout(() => buscar(0), 10);
});

// ---------- Dados / importação / configuração ----------
const UFS = 'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'.split(' ');
$('#uf-anm').innerHTML = UFS.map((u) => `<option>${u}</option>`).join('');
async function carregarDados() {
  const [r, cfg] = await Promise.all([api('/api/resumo'), api('/api/config')]);
  $('#ufs-carregadas').innerHTML = r.ufs.map((u) => `<div><b>${esc(u.uf)}</b> ${fmt(u.total, 0)} processos <button data-uf-rm="${esc(u.uf)}">Remover</button> <button data-uf-up="${esc(u.uf)}">Atualizar da ANM</button></div>`).join('') || '<div class="sub">Base vazia. Baixe uma UF da ANM ou importe um arquivo.</div>';
  $('#lista-importacoes').innerHTML = r.importacoes.map((i) => `<li><div class="tit"><span>${esc(i.origem)}</span><span class="sub">${dataBR(i.data)}</span></div><div class="sub">${fmt(i.total, 0)} processos · ${fmt(i.novos, 0)} novos · ${fmt(i.alterados, 0)} alterados · ${i.alertas} alertas · UFs: ${esc(i.ufs.join(', '))}</div></li>`).join('');
  const fc = $('#form-config');
  fc.urlAnm.value = cfg.urlAnm; fc.urlConsulta.value = cfg.urlConsulta;
  fc.atualizacaoAutomaticaHoras.value = cfg.atualizacaoAutomaticaHoras; fc.ufsAutomaticas.value = (cfg.ufsAutomaticas || []).join(',');
}
$('#ufs-carregadas').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-uf-rm]'), up = e.target.closest('[data-uf-up]');
  if (rm && confirm(`Remover ${rm.dataset.ufRm} da base local?`)) { await api('/api/uf?uf=' + rm.dataset.ufRm, { method: 'DELETE' }); carregarDados(); carregarOpcoes(); }
  if (up) baixarUf(up.dataset.ufUp);
});
async function baixarUf(uf) {
  toast(`Baixando base da ANM para ${uf}… pode levar alguns minutos.`, 60000);
  try { const r = await post('/api/importar/anm', { uf }); toast(`${uf}: ${fmt(r.total, 0)} processos, ${r.novos} novos, ${r.alterados} alterados, ${r.alertas} alertas.`, 8000); }
  catch (e) { toast('Falha: ' + e.message, 10000); }
  carregarDados(); carregarOpcoes(); atualizarBadge(); atualizarMapa();
}
$('#btn-anm').onclick = () => baixarUf($('#uf-anm').value);
$('#form-importar').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target); const arq = f.get('arquivo');
  toast('Importando…', 60000);
  try {
    const r = await api('/api/importar?' + new URLSearchParams({ arquivo: arq.name, uf: f.get('uf'), modo: f.get('modo') }), { method: 'POST', body: arq });
    toast(`${fmt(r.total, 0)} processos importados (${r.novos} novos, ${r.alterados} alterados, ${r.alertas} alertas).`, 8000);
    e.target.reset();
  } catch (err) { toast(err.message, 8000); }
  carregarDados(); carregarOpcoes(); atualizarBadge(); atualizarMapa();
};
$('#form-config').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  await post('/api/config', {
    urlAnm: f.urlAnm.value, urlConsulta: f.urlConsulta.value,
    atualizacaoAutomaticaHoras: Number(f.atualizacaoAutomaticaHoras.value) || 0,
    ufsAutomaticas: f.ufsAutomaticas.value.split(/[,\s]+/).map((s) => s.toUpperCase()).filter(Boolean),
  }, 'PUT');
  toast('Configurações salvas.');
};
$('#arq-backup').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await post('/api/backup', JSON.parse(await f.text())); toast('Backup restaurado.'); } catch (err) { toast(err.message); }
};

// Preenche selects de filtros
async function carregarOpcoes() {
  const r = await api('/api/resumo');
  const opc = (sel, itens, rotulo) => { const v = sel.value; sel.innerHTML = `<option value="">${rotulo}</option>` + itens.map((i) => `<option value="${esc(i.valor)}">${esc(i.valor)} (${fmt(i.qtd, 0)})</option>`).join(''); sel.value = v; };
  opc($('#sel-fase'), r.facetas.fase, 'Todas as fases');
  opc($('#sel-uf'), r.facetas.uf, 'Todas as UFs');
  opc($('#sel-uso'), r.facetas.uso, 'Todos os usos');
  $('#lista-subs').innerHTML = r.facetas.substancia.map((i) => `<option value="${esc(i.valor)}">`).join('');
  if (!r.total) { aviso('Base vazia: vá em "Dados" para baixar processos da ANM ou importar um arquivo.'); }
  return r;
}

// ---------- Início ----------
montarBases();
carregarOpcoes().then((r) => { if (r.total) buscar(0); });
carregarCamadas();
carregarRegioes();
atualizarBadge();
})();
