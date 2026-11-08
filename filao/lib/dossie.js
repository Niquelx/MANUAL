// GeoAnálise: dossiê técnico de uma área (processo ANM, KML/KMZ ou polígono desenhado).
// Junta base local, serviços oficiais online e processamento geofísico em um relatório.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as turf from '@turf/turf';
import AdmZip from 'adm-zip';
import { feicoesNoRetangulo } from './geoservicos.js';
import { processarArea, montarKmz, listarLevantamentos, PALETA_CSS } from './geofisica.js';
import { semAcento } from './categorias.js';

const ANM = 'https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/MapServer';
const arred = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
// valores geofísicos podem ser muito pequenos (ex.: 2ª derivada): usa notação científica
const fmtV = (n) => { const v = Number(n || 0); return v !== 0 && Math.abs(v) < 0.001 ? v.toExponential(2).replace('.', ',') : fmt(v, 4); };

// Busca o polígono de um processo direto no SIGMINE (quando não está na base local)
export async function processoOnline(processo) {
  const m = String(processo).match(/(\d{3})\.?(\d{3})\s*\/\s*(\d{4})/);
  if (!m) throw Object.assign(new Error('Número de processo inválido (use 830.123/2020).'), { status: 400 });
  const num = `${m[1]}.${m[2]}/${m[3]}`;
  const params = new URLSearchParams({ where: `PROCESSO='${num}'`, outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'geojson' });
  const r = await fetch(`${ANM}/0/query?${params}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`SIGMINE respondeu HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'erro no SIGMINE');
  const f = (j.features || [])[0];
  if (!f) throw Object.assign(new Error(`Processo ${num} não encontrado no SIGMINE (ativos).`), { status: 404 });
  const p = f.properties;
  return {
    type: 'Feature', geometry: f.geometry,
    properties: {
      processo: num, fase: p.FASE || '', titular: p.NOME || '', substancia: p.SUBS || '', uso: p.USO || '',
      uf: p.UF || '', area_ha: Number(p.AREA_HA) || 0, ult_evento: p.ULT_EVENTO || '', fonte: 'SIGMINE online',
    },
  };
}

function campo(props, ...res) {
  const k = Object.keys(props).find((x) => res.some((r) => r.test(x)));
  return k ? props[k] : '';
}

function areaInter(a, b) {
  try {
    const i = turf.intersect(turf.featureCollection([a, b.type === 'Feature' ? b : turf.feature(b)]));
    return i ? turf.area(i) / 10000 : 0;
  } catch { return 0; }
}

function distanciaKm(area, f) {
  try {
    if (turf.booleanIntersects(area, f)) return 0;
    const pt = f.geometry.type === 'Point' ? f : turf.pointOnFeature(f);
    const linha = turf.polygonToLine(area);
    const ls = linha.type === 'FeatureCollection' ? linha.features : [linha];
    return Math.min(...ls.map((l) => turf.pointToLineDistance(pt, l, { units: 'kilometers' })));
  } catch { return NaN; }
}

export async function gerarDossie(ctx, entrada, opcoes = {}, progresso = () => {}) {
  const { base, dirDados, camadaEfetiva, camadaResolvida } = ctx;
  const raioKm = Number(opcoes.raioKm ?? 10);
  const bufferKm = Number(opcoes.bufferKm ?? 2);
  const etapas = [];
  const etapa = (nome, status, detalhe = '') => { etapas.push({ nome, status, detalhe }); progresso(etapas); };

  // 1. Área de interesse
  let area, props = {};
  if (entrada.processo) {
    const local = base.indice.get(entrada.processo) || base.removidos.get(entrada.processo);
    if (local) { area = turf.feature(local.geometry); props = { ...local.properties, fonte: 'base local' }; }
    else { const on = await processoOnline(entrada.processo); area = turf.feature(on.geometry); props = on.properties; }
  } else if (entrada.geometria) {
    area = turf.feature(entrada.geometria.type === 'Feature' ? entrada.geometria.geometry : entrada.geometria);
  } else throw Object.assign(new Error('Informe um processo ou uma geometria.'), { status: 400 });
  if (!/Polygon/.test(area.geometry.type)) throw Object.assign(new Error('A área precisa ser um polígono.'), { status: 400 });
  const titulo = entrada.nome || (props.processo ? `Processo ${props.processo}` : 'Área de interesse');
  const areaHa = turf.area(area) / 10000;
  const centroide = turf.centroid(area).geometry.coordinates;
  const vizinhanca = turf.buffer(area, raioKm, { units: 'kilometers' });
  const bbViz = turf.bbox(vizinhanca);
  const bbArea = turf.bbox(turf.buffer(area, 0.2, { units: 'kilometers' }));
  const uf = (opcoes.uf || props.uf || '').toUpperCase().slice(0, 2);
  etapa('Área de interesse', 'ok', `${fmt(areaHa)} ha`);

  const res = {
    id: entrada.id, titulo, criado: new Date().toISOString(), opcoes: { raioKm, bufferKm, uf },
    area: { ha: arred(areaHa), perimetro_km: arred(turf.length(turf.polygonToLine(area), { units: 'kilometers' })), centroide, bbox: turf.bbox(area), propriedades: props },
    etapas,
  };
  const contexto = [];

  // 2. Base local: interferências, vizinhos, minas ativas e áreas que saíram da base
  const inter = base.interferencia(area.geometry);
  res.interferencias = {
    area_livre_ha: inter.area_livre_ha, area_ocupada_ha: inter.area_ocupada_ha, perc_livre: inter.perc_livre,
    itens: inter.interferencias.filter((i) => i.processo !== props.processo).slice(0, 100),
  };
  const vizinhos = base.candidatos(bbViz).filter((f) => f.properties.processo !== props.processo)
    .map((f) => ({ f, d: distanciaKm(area, f) })).filter((x) => x.d <= raioKm).sort((a, b) => a.d - b.d);
  res.vizinhos = {
    total: vizinhos.length,
    por_fase: Object.entries(vizinhos.reduce((m, x) => ((m[x.f.properties.fase] = (m[x.f.properties.fase] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]),
    por_substancia: Object.entries(vizinhos.reduce((m, x) => ((m[x.f.properties.substancia] = (m[x.f.properties.substancia] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 12),
    itens: vizinhos.slice(0, 40).map((x) => ({ ...x.f.properties, distancia_km: arred(x.d) })),
  };
  res.minas_ativas = vizinhos.filter((x) => base.cfemAtiva(x.f.properties)).map((x) => ({ ...x.f.properties, distancia_km: arred(x.d), cfem: base.cfemDe(x.f.properties) })).slice(0, 30);
  res.areas_liberadas = [...base.removidos.values()].filter((f) => f.properties.livre)
    .map((f) => ({ f, d: distanciaKm(area, f) })).filter((x) => x.d <= raioKm).slice(0, 30)
    .map((x) => ({ ...x.f.properties, distancia_km: arred(x.d) }));
  for (const i of inter.interferencias) { const f = base.indice.get(i.processo); if (f) contexto.push({ ...f, properties: { _tipo: 'processo', processo: i.processo, fase: i.fase } }); }
  etapa('Base local (processos, CFEM)', 'ok', `${res.interferencias.itens.length} interferências, ${vizinhos.length} processos em ${raioKm} km`);

  // 3. Consultas online aos serviços oficiais
  const online = async (nome, id, bbox, fn, extra = {}) => {
    const c = camadaEfetiva(id);
    if (!c) return null;
    try {
      const feats = await feicoesNoRetangulo(c, camadaResolvida(id), bbox, extra);
      const r = fn(feats);
      etapa(nome, 'ok', r.resumo || `${feats.length} feições`);
      return r;
    } catch (e) {
      etapa(nome, 'erro', e.message);
      return { erro: e.message };
    }
  };
  const litologia = (feats) => {
    const grupos = new Map();
    for (const f of feats) {
      const ha = areaInter(area, f);
      if (ha <= 0) continue;
      const p = f.properties;
      const sigla = campo(p, /^SIGLA/i, /^COD_UNI/i) || '';
      const nome = campo(p, /^NOME/i, /UNIDADE/i, /^NM_/i) || sigla || 'Unidade sem nome';
      const chave = `${sigla}|${nome}`;
      const g = grupos.get(chave) || { sigla, nome, area_ha: 0, litotipos: campo(p, /LITOTIP/i, /LITOLOG/i, /^ROCHA/i), idade: [campo(p, /ERA_MAX|ERA_MIN|^ERA/i), campo(p, /PERIODO|EPOCA/i), campo(p, /IDADE/i)].filter(Boolean).join(' · ') };
      g.area_ha += ha;
      grupos.set(chave, g);
      contexto.push({ type: 'Feature', geometry: f.geometry, properties: { _tipo: 'litologia', sigla, nome } });
    }
    const itens = [...grupos.values()].map((g) => ({ ...g, area_ha: arred(g.area_ha), perc: arred((g.area_ha / areaHa) * 100, 1) })).sort((a, b) => b.area_ha - a.area_ha);
    return { itens, resumo: `${itens.length} unidade(s) na área` };
  };
  const proximidade = (tipo) => (feats) => {
    const itens = feats.map((f) => ({ f, d: distanciaKm(area, f) })).filter((x) => x.d <= raioKm).sort((a, b) => a.d - b.d)
      .map((x) => {
        contexto.push({ type: 'Feature', geometry: x.f.geometry, properties: { _tipo: tipo, nome: campo(x.f.properties, /NOME|TERRAI_NOM|NM_|SUBST|SUBS/i) } });
        return { distancia_km: arred(x.d), sobreposicao_ha: x.d === 0 && x.f.geometry.type !== 'Point' ? arred(areaInter(area, x.f)) : 0, atributos: limparAttrs(x.f.properties) };
      });
    return { itens: itens.slice(0, 60), total: itens.length, intersecta: itens.filter((i) => i.distancia_km === 0).length, resumo: `${itens.length} em ${raioKm} km, ${itens.filter((i) => i.distancia_km === 0).length} sobre a área` };
  };

  const tarefas = {
    litologia_1m: online('Geologia 1:1.000.000 (SGB)', 'geologia_1m', bbArea, litologia),
    litologia_250k: online('Geologia 1:250.000 (SGB)', 'geologia_250k', bbArea, litologia),
    ocorrencias: online('Ocorrências minerais (SGB)', 'ocorrencias_sgb', bbViz, proximidade('ocorrencia'), { max: 2000 }),
    terras_indigenas: online('Terras Indígenas (FUNAI)', 'terras_indigenas', bbViz, proximidade('ti')),
    unidades_conservacao: online('Unidades de Conservação (MMA)', 'unidades_conservacao', bbViz, proximidade('uc')),
    bloqueio: online('Áreas de bloqueio (ANM)', 'anm_bloqueio', bbViz, proximidade('restricao')),
    protecao_fonte: online('Proteção de fonte (ANM)', 'anm_fonte', bbViz, proximidade('restricao')),
    reservas_garimpeiras: online('Reservas garimpeiras (ANM)', 'anm_garimpeiras', bbViz, proximidade('restricao')),
    arrendamentos: online('Arrendamentos (ANM)', 'anm_arrendamento', bbArea, proximidade('restricao')),
  };
  if (uf) {
    tarefas.sicar = online(`Imóveis rurais SICAR (${uf})`, 'sicar', bbArea, (feats) => {
      const itens = feats.map((f) => ({ ha: areaInter(area, f), p: f.properties })).filter((x) => x.ha > 0);
      return { total: itens.length, sobreposicao_ha: arred(itens.reduce((s, x) => s + x.ha, 0)), itens: itens.slice(0, 50).map((x) => ({ sobreposicao_ha: arred(x.ha), atributos: limparAttrs(x.p) })), resumo: `${itens.length} imóvel(is) na área` };
    }, { max: 500, camadaWms: `sicar:sicar_imoveis_${uf.toLowerCase()}` });
  } else etapa('Imóveis rurais SICAR', 'pulado', 'Informe a UF para consultar.');
  if (opcoes.online === false) for (const k of Object.keys(tarefas)) tarefas[k] = Promise.resolve({ erro: 'consultas online desativadas' });
  for (const [k, p] of Object.entries(tarefas)) res[k] = await p;

  // 4. Geofísica
  let levId = opcoes.levantamento;
  if (!levId && opcoes.geofisica !== false) {
    const [cx, cy] = centroide;
    const cobre = listarLevantamentos(path.join(dirDados, 'geofisica')).find((l) => cx >= l.bbox[0] && cx <= l.bbox[2] && cy >= l.bbox[1] && cy <= l.bbox[3]);
    levId = cobre?.id;
  }
  const dirSaida = path.join(dirDados, 'geoanalises', entrada.id);
  fs.mkdirSync(dirSaida, { recursive: true });
  if (levId) {
    try {
      res.geofisica = await processarArea(path.join(dirDados, 'geofisica'), levId, area, path.join(dirSaida, 'geofisica'), { bufferKm, celula: opcoes.celula });
      fs.writeFileSync(path.join(dirSaida, 'geofisica.kmz'), montarKmz(path.join(dirSaida, 'geofisica'), res.geofisica, area, titulo));
      etapa('Processamento geofísico', 'ok', `${res.geofisica.produtos.length} produtos, célula ${res.geofisica.grade.celula} m`);
    } catch (e) { res.geofisica = { erro: e.message }; etapa('Processamento geofísico', 'erro', e.message); }
  } else etapa('Processamento geofísico', 'pulado', 'Nenhum levantamento aerogeofísico importado cobre a área.');

  // 5. Síntese
  res.sintese = sintese(res, props, opcoes.substanciaAlvo);
  fs.writeFileSync(path.join(dirSaida, 'area.geojson'), JSON.stringify(area));
  fs.writeFileSync(path.join(dirSaida, 'contexto.geojson'), JSON.stringify({ type: 'FeatureCollection', features: contexto.slice(0, 5000) }));
  fs.writeFileSync(path.join(dirSaida, 'resultado.json'), JSON.stringify(res));
  fs.writeFileSync(path.join(dirSaida, 'relatorio.html'), relatorioHtml(res, area, contexto, dirSaida));
  fs.writeFileSync(path.join(dirSaida, 'pacote.zip'), pacote(res, area, dirSaida));
  etapa('Relatório e pacote GIS', 'ok');
  return res;
}

function limparAttrs(p) {
  return Object.fromEntries(Object.entries(p || {}).filter(([k, v]) => v !== null && v !== '' && !/^(_|shape|objectid|fid|the_geom|geom|globalid|st_area|st_length|bbox)/i.test(k)).slice(0, 14));
}

function sintese(r, props, alvo) {
  const atencao = [], favoravel = [], info = [];
  const n = (x) => (x && !x.erro ? x : null);
  if (n(r.terras_indigenas)?.intersecta) atencao.push(`Sobreposição com Terra Indígena (${r.terras_indigenas.intersecta}). Atividade minerária depende de regulamentação específica (CF, art. 231, §3º).`);
  else if (n(r.terras_indigenas)?.total) info.push(`${r.terras_indigenas.total} Terra(s) Indígena(s) a até ${r.opcoes.raioKm} km.`);
  if (n(r.unidades_conservacao)?.intersecta) atencao.push(`Sobreposição com ${r.unidades_conservacao.intersecta} Unidade(s) de Conservação: verificar categoria (proteção integral impede mineração) e plano de manejo.`);
  else if (n(r.unidades_conservacao)?.total) info.push(`${r.unidades_conservacao.total} Unidade(s) de Conservação a até ${r.opcoes.raioKm} km (verificar zona de amortecimento).`);
  for (const [k, rot] of [['bloqueio', 'área de bloqueio'], ['protecao_fonte', 'área de proteção de fonte'], ['reservas_garimpeiras', 'reserva garimpeira'], ['arrendamentos', 'arrendamento']]) {
    if (n(r[k])?.intersecta) atencao.push(`Sobreposição com ${rot} da ANM (${r[k].intersecta}).`);
  }
  if (r.interferencias.itens.length) atencao.push(`${r.interferencias.itens.length} processo(s) com interferência; área livre estimada ${fmt(r.interferencias.area_livre_ha)} ha (${fmt(r.interferencias.perc_livre)}%).`);
  if (n(r.sicar)?.total) info.push(`${r.sicar.total} imóvel(is) rural(is) do CAR sobre a área (superficiários a negociar).`);
  const subsAlvo = semAcento(alvo || props.substancia || '');
  const oc = n(r.ocorrencias);
  if (oc?.total) {
    const mesma = subsAlvo ? oc.itens.filter((i) => semAcento(JSON.stringify(i.atributos)).includes(subsAlvo.split(' ')[0])).length : 0;
    favoravel.push(`${oc.total} ocorrência(s) mineral(is) do SGB a até ${r.opcoes.raioKm} km${oc.intersecta ? `, ${oc.intersecta} dentro da área` : ''}${mesma ? `; ${mesma} citam ${subsAlvo.toLowerCase()}` : ''}.`);
  }
  if (r.minas_ativas.length) favoravel.push(`${r.minas_ativas.length} mina(s) com recolhimento recente de CFEM na vizinhança (a mais próxima a ${fmt(r.minas_ativas[0].distancia_km)} km).`);
  if (r.areas_liberadas.length) info.push(`${r.areas_liberadas.length} área(s) que saíram da base ativa e não têm sobreposição na vizinhança (possíveis áreas livres).`);
  for (const a of r.geofisica?.anomalias || []) if (a.perc_area >= 3) favoravel.push(`${a.descricao}: ${fmt(a.perc_area, 1)}% da área acima de média + 2σ (máximo em ${a.ponto_maximo[1]}, ${a.ponto_maximo[0]}).`);
  const lito = n(r.litologia_250k)?.itens?.length ? r.litologia_250k : n(r.litologia_1m);
  if (lito?.itens?.length) info.push(`Geologia predominante: ${lito.itens.slice(0, 3).map((i) => `${i.sigla || i.nome} (${fmt(i.perc, 1)}%)`).join(', ')}.`);
  return { atencao, favoravel, info };
}

// ---------------------------------------------------------------------------
// Relatório HTML autocontido (imprimível em PDF pelo navegador)
// ---------------------------------------------------------------------------
const CORES_LITO = ['#e8c07d', '#b5d99c', '#f4a582', '#92c5de', '#d6b4fc', '#fddbc7', '#c7e9c0', '#fdae6b', '#9ecae1', '#dadaeb', '#e7cb94', '#bcbddc'];

function mapaSvg(area, contexto, raioBox) {
  const W = 720, H = 520;
  const bb = raioBox;
  const kx = Math.cos(((bb[1] + bb[3]) / 2) * Math.PI / 180);
  const sx = W / ((bb[2] - bb[0]) * kx), sy = H / (bb[3] - bb[1]);
  const s = Math.min(sx, sy);
  const ox = (W - (bb[2] - bb[0]) * kx * s) / 2, oy = (H - (bb[3] - bb[1]) * s) / 2;
  const P = ([x, y]) => `${(ox + (x - bb[0]) * kx * s).toFixed(1)},${(oy + (bb[3] - y) * s).toFixed(1)}`;
  const caminho = (g) => {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.map((p) => p.map((r) => 'M' + r.map(P).join('L') + 'Z').join('')).join('');
  };
  const sigl = new Map();
  let out = '';
  for (const f of contexto.filter((x) => x.properties._tipo === 'litologia')) {
    const k = f.properties.sigla || f.properties.nome;
    if (!sigl.has(k)) sigl.set(k, CORES_LITO[sigl.size % CORES_LITO.length]);
    out += `<path d="${caminho(f.geometry)}" fill="${sigl.get(k)}" stroke="#8a7a60" stroke-width="0.4" fill-opacity="0.8"/>`;
  }
  const estilos = { ti: ['#a0522d', '6 3'], uc: ['#2f9e44', '6 3'], restricao: ['#c92a2a', '2 2'], processo: ['#1c7ed6', ''] };
  for (const f of contexto.filter((x) => estilos[x.properties._tipo])) {
    const [c, d] = estilos[f.properties._tipo];
    out += `<path d="${caminho(f.geometry)}" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="1.2" ${d ? `stroke-dasharray="${d}"` : ''}/>`;
  }
  out += `<path d="${caminho(area.geometry)}" fill="#ffd43b" fill-opacity="0.25" stroke="#000" stroke-width="2.2"/>`;
  for (const f of contexto.filter((x) => x.properties._tipo === 'ocorrencia' && x.geometry.type === 'Point')) {
    const [x, y] = P(f.geometry.coordinates).split(',');
    out += `<circle cx="${x}" cy="${y}" r="3.5" fill="#d9480f" stroke="#fff" stroke-width="1"><title>${esc(f.properties.nome)}</title></circle>`;
  }
  // escala
  const kmPx = s * kx / (111.32);
  const passos = [0.5, 1, 2, 5, 10, 20, 50];
  const km = passos.find((v) => v * kmPx > 80) || 50;
  out += `<g transform="translate(16,${H - 22})"><rect width="${km * kmPx}" height="6" fill="#000"/><text y="-4" font-size="11">${km} km</text></g>`;
  out += `<g transform="translate(${W - 30},34)"><path d="M0,-20 L7,4 L0,0 L-7,4Z" fill="#000"/><text x="-4" y="16" font-size="12">N</text></g>`;
  const leg = [...sigl.entries()].slice(0, 12).map(([k, c]) => `<span><i style="background:${c}"></i>${esc(k)}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="mapa-svg" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#fbfaf7"/>${out}</svg>
    <div class="leg">${leg}<span><i style="background:#ffd43b;border:2px solid #000"></i>Área analisada</span><span><i style="background:#1c7ed6"></i>Processo com interferência</span><span><i style="background:#d9480f;border-radius:50%"></i>Ocorrência mineral</span><span><i style="border:2px dashed #a0522d"></i>Terra Indígena</span><span><i style="border:2px dashed #2f9e44"></i>Unid. Conservação</span><span><i style="border:2px dotted #c92a2a"></i>Restrição ANM</span></div>`;
}

function tabela(cab, linhas) {
  if (!linhas.length) return '<p class="vazio">Nenhum registro.</p>';
  return `<table><thead><tr>${cab.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function blocoOnline(titulo, r, render) {
  if (!r) return '';
  if (r.erro) return `<h3>${esc(titulo)}</h3><p class="erro">Não consultado: ${esc(r.erro)}</p>`;
  return `<h3>${esc(titulo)}</h3>${render(r)}`;
}

function attrsTxt(a) { return esc(Object.entries(a || {}).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(' · ')); }

function relatorioHtml(r, area, contexto, dirSaida) {
  const bbViz = turf.bbox(turf.buffer(area, Math.max(1, r.opcoes.raioKm * 0.6), { units: 'kilometers' }));
  const p = r.area.propriedades;
  const geo = r.geofisica && !r.geofisica.erro ? r.geofisica : null;
  const img = (id) => { try { return 'data:image/png;base64,' + fs.readFileSync(path.join(dirSaida, 'geofisica', 'produtos', `${id}.png`)).toString('base64'); } catch { return ''; } };
  const lito = (x) => tabela(['Sigla', 'Unidade', 'Litotipos', 'Idade', 'Área (ha)', '% da área'], (x.itens || []).map((i) => [esc(i.sigla), esc(i.nome), esc(String(i.litotipos).slice(0, 200)), esc(i.idade), fmt(i.area_ha), fmt(i.perc, 1)]));
  const prox = (x) => `<p>${x.total} registro(s) a até ${r.opcoes.raioKm} km; ${x.intersecta} sobre a área.</p>` + tabela(['Distância (km)', 'Sobreposição (ha)', 'Atributos'], x.itens.slice(0, 40).map((i) => [fmt(i.distancia_km), i.sobreposicao_ha ? fmt(i.sobreposicao_ha) : '—', attrsTxt(i.atributos)]));
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GeoAnálise · ${esc(r.titulo)}</title>
<style>
body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;max-width:980px;margin:0 auto;padding:24px;background:#fff}
h1{font-size:22px;margin:0}h2{font-size:16px;border-bottom:2px solid #b5651d;padding-bottom:4px;margin-top:28px}h3{font-size:14px;margin:16px 0 6px}
.sub{color:#5b636d}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}.cards div{border:1px solid #dcdad4;border-radius:6px;padding:8px}.cards b{display:block;font-size:18px}
table{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0}th,td{border-bottom:1px solid #e5e2db;padding:4px;text-align:left;vertical-align:top}th{background:#f6f5f2}
.erro{color:#c92a2a}.vazio{color:#868e96}.sint li{margin:3px 0}.at{color:#c92a2a}.fv{color:#2f9e44}
.mapa-svg{width:100%;border:1px solid #dcdad4;border-radius:6px}.leg{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;margin:6px 0}.leg span{display:flex;align-items:center;gap:4px}.leg i{display:inline-block;width:14px;height:10px}
.galeria{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.galeria figure{margin:0;border:1px solid #e5e2db;border-radius:6px;padding:6px;break-inside:avoid}.galeria img{width:100%;image-rendering:auto}.galeria figcaption{font-size:11px}
.barra{height:8px;border-radius:2px;background:${PALETA_CSS}}.esc{display:flex;justify-content:space-between;font-size:10px;color:#5b636d}
.aviso{background:#fff8e6;border:1px solid #f0d58a;padding:8px;border-radius:6px;font-size:12px}
@media print{body{padding:0}h2{break-after:avoid}.galeria{grid-template-columns:repeat(3,1fr)}}
</style></head><body>
<h1>GeoAnálise: ${esc(r.titulo)}</h1>
<div class="sub">Gerado em ${new Date(r.criado).toLocaleString('pt-BR')} pelo Filão (uso pessoal). Raio de contexto ${r.opcoes.raioKm} km.</div>
<div class="cards">
<div>Área<b>${fmt(r.area.ha)} ha</b></div><div>Perímetro<b>${fmt(r.area.perimetro_km)} km</b></div>
<div>Área livre (base local)<b>${fmt(r.interferencias.perc_livre)}%</b></div><div>Centroide<b style="font-size:13px">${r.area.centroide[1].toFixed(5)}, ${r.area.centroide[0].toFixed(5)}</b></div>
</div>
${p.processo ? `<table><tr><th>Processo</th><td>${esc(p.processo)}</td><th>Fase</th><td>${esc(p.fase)}</td></tr><tr><th>Titular</th><td>${esc(p.titular)}</td><th>Substância</th><td>${esc(p.substancia)}</td></tr><tr><th>Último evento</th><td colspan="3">${esc(p.ult_evento)}</td></tr><tr><th>Fonte</th><td colspan="3">${esc(p.fonte || '')}</td></tr></table>` : ''}
<h2>Síntese</h2>
<ul class="sint">${r.sintese.atencao.map((t) => `<li class="at">⚠ ${esc(t)}</li>`).join('')}${r.sintese.favoravel.map((t) => `<li class="fv">✔ ${esc(t)}</li>`).join('')}${r.sintese.info.map((t) => `<li>• ${esc(t)}</li>`).join('')}</ul>
<p class="aviso">A síntese aplica regras simples sobre dados públicos e não substitui parecer técnico, vistoria de campo nem consulta oficial à ANM e aos órgãos ambientais.</p>
<h2>Mapa de situação</h2>
${mapaSvg(area, contexto, bbViz)}
<h2>Geologia</h2>
${blocoOnline('Unidades litoestratigráficas 1:250.000 (SGB)', r.litologia_250k, lito)}
${blocoOnline('Unidades litoestratigráficas 1:1.000.000 (SGB)', r.litologia_1m, lito)}
${blocoOnline('Ocorrências minerais (SGB)', r.ocorrencias, prox)}
<h2>Restrições e áreas especiais</h2>
${blocoOnline('Terras Indígenas (FUNAI)', r.terras_indigenas, prox)}
${blocoOnline('Unidades de Conservação (MMA/CNUC)', r.unidades_conservacao, prox)}
${blocoOnline('Áreas de bloqueio (ANM)', r.bloqueio, prox)}
${blocoOnline('Áreas de proteção de fonte (ANM)', r.protecao_fonte, prox)}
${blocoOnline('Reservas garimpeiras (ANM)', r.reservas_garimpeiras, prox)}
${blocoOnline('Arrendamentos (ANM)', r.arrendamentos, prox)}
${blocoOnline('Imóveis rurais (SICAR)', r.sicar, (x) => `<p>${x.total} imóvel(is), ${fmt(x.sobreposicao_ha)} ha sobrepostos.</p>` + tabela(['Sobreposição (ha)', 'Atributos'], x.itens.map((i) => [fmt(i.sobreposicao_ha), attrsTxt(i.atributos)])))}
<h2>Direitos minerários</h2>
<h3>Interferências (base local)</h3>
<p>Área ocupada ${fmt(r.interferencias.area_ocupada_ha)} ha · área livre ${fmt(r.interferencias.area_livre_ha)} ha (${fmt(r.interferencias.perc_livre)}%).</p>
${tabela(['Processo', 'Fase', 'Titular', 'Substância', 'Sobreposição (ha)', '% da área'], r.interferencias.itens.map((i) => [esc(i.processo), esc(i.fase), esc(i.titular), esc(i.substancia), fmt(i.area_sobreposta_ha), fmt(i.perc_do_alvo)]))}
<h3>Vizinhança (${r.vizinhos.total} processos a até ${r.opcoes.raioKm} km)</h3>
<p>${r.vizinhos.por_fase.map(([f, n]) => `${esc(f)}: ${n}`).join(' · ')}</p>
<p>Substâncias: ${r.vizinhos.por_substancia.map(([f, n]) => `${esc(f)}: ${n}`).join(' · ')}</p>
${tabela(['Processo', 'Distância (km)', 'Fase', 'Substância', 'Titular'], r.vizinhos.itens.slice(0, 25).map((i) => [esc(i.processo), fmt(i.distancia_km), esc(i.fase), esc(i.substancia), esc(i.titular)]))}
<h3>Minas ativas (CFEM) na vizinhança</h3>
${tabela(['Processo', 'Distância (km)', 'Substância', 'Último recolhimento', 'Total recolhido (R$)'], r.minas_ativas.map((i) => [esc(i.processo), fmt(i.distancia_km), esc(i.substancia), esc(i.cfem?.ultimo), fmt(i.cfem?.valor)]))}
<h3>Áreas que saíram da base ativa (possíveis áreas livres)</h3>
${tabela(['Processo', 'Distância (km)', 'Fase anterior', 'Substância', 'Saiu em'], r.areas_liberadas.map((i) => [esc(i.processo), fmt(i.distancia_km), esc(i.fase), esc(i.substancia), esc(String(i.removido_em).slice(0, 10))]))}
<h2>Geofísica</h2>
${geo ? `<p>Levantamento: <b>${esc(geo.levantamento.nome)}</b> · célula ${geo.grade.celula} m · SIRGAS 2000 / UTM ${geo.grade.zona}${geo.grade.sul ? 'S' : 'N'} (EPSG ${geo.grade.epsg}) · pontos usados: ${Object.entries(geo.pontos).map(([k, v]) => `${k} ${fmt(v, 0)}`).join(', ')}.</p>
<h3>Anomalias na área</h3>
${tabela(['Indicador', '% da área acima de média+2σ', 'Máximo', 'Local do máximo (lat, lon)'], geo.anomalias.map((a) => [esc(a.descricao), fmt(a.perc_area, 1), fmtV(a.maximo), `${a.ponto_maximo[1]}, ${a.ponto_maximo[0]}`]))}
<div class="galeria">${geo.produtos.map((pr) => `<figure><img src="${img(pr.id)}" alt=""><figcaption><b>${esc(pr.nome)}</b> (${esc(pr.unidade)})<br>${pr.legenda?.tipo === 'equalizado' ? `<div class="barra"></div><div class="esc"><span>${fmtV(pr.legenda.p2)}</span><span>${fmtV(pr.legenda.p50)}</span><span>${fmtV(pr.legenda.p98)}</span></div>` : ''}${esc(pr.nota)}${pr.estatisticas?.celulas_na_area ? `<br>Na área: média ${fmtV(pr.estatisticas.media)}, mín ${fmtV(pr.estatisticas.min)}, máx ${fmtV(pr.estatisticas.max)}` : ''}</figcaption></figure>`).join('')}</div>
<p class="sub">Cores com equalização de histograma (escala mostra os percentis 2, 50 e 98). Grades em ASCII (.asc) e imagens georreferenciadas estão no pacote GIS.</p>`
    : `<p class="vazio">${esc(r.geofisica?.erro || 'Nenhum levantamento aerogeofísico importado cobre a área. Baixe os dados do projeto aerogeofísico no GeoSGB (SGB) e importe na aba Dados.')}</p>`}
<h2>Fontes e etapas</h2>
${tabela(['Etapa', 'Situação', 'Detalhe'], r.etapas.map((e) => [esc(e.nome), esc(e.status), esc(e.detalhe)]))}
<p class="sub">Fontes: ANM/SIGMINE e CFEM (dados abertos), SGB/CPRM (GeoSGB), FUNAI, MMA/CNUC, SFB/SICAR. Consultas feitas em ${new Date(r.criado).toLocaleString('pt-BR')}. Os dados públicos podem ter mudado depois.</p>
</body></html>`;
}

function pacote(r, area, dirSaida) {
  const zip = new AdmZip();
  const add = (nome, conteudo) => zip.addFile(nome, Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo));
  add('relatorio.html', fs.readFileSync(path.join(dirSaida, 'relatorio.html')));
  add('area.geojson', JSON.stringify(area));
  add('contexto.geojson', fs.readFileSync(path.join(dirSaida, 'contexto.geojson')));
  add('resultado.json', JSON.stringify(r, null, 1));
  const csv = (cab, linhas) => '﻿' + [cab.join(';'), ...linhas.map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';'))].join('\r\n');
  add('interferencias.csv', csv(['processo', 'fase', 'titular', 'substancia', 'sobreposicao_ha', 'perc_area'], r.interferencias.itens.map((i) => [i.processo, i.fase, i.titular, i.substancia, i.area_sobreposta_ha, i.perc_do_alvo])));
  add('vizinhos.csv', csv(['processo', 'distancia_km', 'fase', 'substancia', 'titular'], r.vizinhos.itens.map((i) => [i.processo, i.distancia_km, i.fase, i.substancia, i.titular])));
  for (const k of ['litologia_1m', 'litologia_250k']) if (r[k]?.itens) add(`${k}.csv`, csv(['sigla', 'nome', 'litotipos', 'idade', 'area_ha', 'perc'], r[k].itens.map((i) => [i.sigla, i.nome, i.litotipos, i.idade, i.area_ha, i.perc])));
  if (r.ocorrencias?.itens) add('ocorrencias.csv', csv(['distancia_km', 'atributos'], r.ocorrencias.itens.map((i) => [i.distancia_km, JSON.stringify(i.atributos)])));
  const dg = path.join(dirSaida, 'geofisica');
  if (fs.existsSync(dg)) {
    for (const sub of ['produtos', 'grades']) {
      const d = path.join(dg, sub);
      if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) add(`geofisica/${sub}/${f}`, fs.readFileSync(path.join(d, f)));
    }
    if (fs.existsSync(path.join(dirSaida, 'geofisica.kmz'))) add('geofisica.kmz', fs.readFileSync(path.join(dirSaida, 'geofisica.kmz')));
  }
  add('LEIA-ME.txt', `GeoAnálise: ${r.titulo}\n\nrelatorio.html: abra no navegador e use Imprimir > Salvar como PDF.\ngeofisica/grades/*.asc: grades ESRI ASCII em SIRGAS 2000 / UTM (o .prj acompanha). Abrem no QGIS/ArcGIS.\ngeofisica/produtos/*.png: imagens georreferenciadas (world file .pgw, SIRGAS 2000 geográfico).\ngeofisica.kmz: produtos para o Google Earth.\ncontexto.geojson: feições consultadas (litologia, restrições, ocorrências, interferências).\n`);
  return zip.toBuffer();
}

export const novoId = () => 'ga_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + crypto.randomUUID().slice(0, 6);
