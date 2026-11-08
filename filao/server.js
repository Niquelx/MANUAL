// Filão: servidor local (uso pessoal). Sem dependências de framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Base } from './lib/base.js';
import { lerArquivoGeo } from './lib/importador.js';
import { CATEGORIAS, GRUPOS_CATEGORIAS } from './lib/categorias.js';
import { CATALOGO, GRUPOS_CAMADAS, camadaPorId } from './lib/catalogo.js';
import { resolver, consultar, legenda } from './lib/geoservicos.js';
import { lerCfem } from './lib/cfem.js';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.PORTA || process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const LIMITE_UPLOAD = 1024 * 1024 * 1024; // 1 GB
const LIMITE_MAPA = 4000;

export const base = new Base(process.env.DADOS || path.join(RAIZ, 'data'));

const ESTATICOS = {
  '/vendor/leaflet/': path.join(RAIZ, 'node_modules/leaflet/dist/'),
  '/vendor/geoman/': path.join(RAIZ, 'node_modules/@geoman-io/leaflet-geoman-free/dist/'),
  '/': path.join(RAIZ, 'public/'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
};

function enviarJson(res, dados, status = 200) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(corpo);
}

function lerCorpo(req, limite = LIMITE_UPLOAD) {
  return new Promise((ok, erro) => {
    const partes = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limite) { erro(new Error('Arquivo grande demais.')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', erro);
  });
}

async function lerJson(req) {
  const b = await lerCorpo(req, 50 * 1024 * 1024);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
}

function servirEstatico(req, res, rota) {
  for (const [prefixo, dir] of Object.entries(ESTATICOS)) {
    if (!rota.startsWith(prefixo)) continue;
    let rel = decodeURIComponent(rota.slice(prefixo.length)) || 'index.html';
    const arq = path.normalize(path.join(dir, rel));
    if (!arq.startsWith(dir)) break;
    if (fs.existsSync(arq) && fs.statSync(arq).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(arq)] || 'application/octet-stream' });
      fs.createReadStream(arq).pipe(res);
      return true;
    }
  }
  return false;
}

const resumo = (f) => ({ ...f.properties, bbox: f.bbox });

// ---------- Exportação ----------
const CAMPOS_EXPORT = ['processo', 'numero', 'ano', 'area_ha', 'fase', 'ult_evento', 'titular', 'substancia', 'uso', 'uf'];

function paraCsv(lista) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [CAMPOS_EXPORT.join(';')];
  for (const f of lista) linhas.push(CAMPOS_EXPORT.map((c) => esc(f.properties[c])).join(';'));
  return '﻿' + linhas.join('\r\n');
}

function paraKml(lista) {
  const xml = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const anel = (r) => `<LinearRing><coordinates>${r.map((c) => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LinearRing>`;
  const poligono = (p) => `<Polygon><outerBoundaryIs>${anel(p[0])}</outerBoundaryIs>${p.slice(1).map((r) => `<innerBoundaryIs>${anel(r)}</innerBoundaryIs>`).join('')}</Polygon>`;
  const geom = (g) => {
    if (g.type === 'Polygon') return poligono(g.coordinates);
    if (g.type === 'MultiPolygon') return `<MultiGeometry>${g.coordinates.map(poligono).join('')}</MultiGeometry>`;
    return '';
  };
  const marcas = lista.map((f) => {
    const p = f.properties;
    const dados = CAMPOS_EXPORT.map((c) => `<Data name="${c}"><value>${xml(p[c])}</value></Data>`).join('');
    return `<Placemark><name>${xml(p.processo)}</name><description>${xml(`${p.fase} | ${p.substancia} | ${p.titular}`)}</description><ExtendedData>${dados}</ExtendedData>${geom(f.geometry)}</Placemark>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Processos exportados</name>\n${marcas}\n</Document></kml>`;
}

// ---------- Download da base oficial ----------
async function baixarAnm(uf) {
  uf = String(uf).toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) throw new Error('UF inválida.');
  const url = base.estado.config.urlAnm.replace('{UF}', uf);
  const r = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!r.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const features = await lerArquivoGeo(buf, `${uf}.zip`);
  return base.importarProcessos(features, { ufPadrao: uf, origem: `ANM ${uf}` });
}

// ---------- Catálogo de camadas oficiais ----------
function camadaEfetiva(id) {
  const c = camadaPorId(id);
  if (!c) return null;
  const cache = base.catalogoCache[id];
  if (!cache?.manual) return c;
  const temCamada = !!cache.camada;
  const temIds = !!cache.camadas?.length;
  return {
    ...c,
    url: cache.url || c.url,
    camada: temCamada ? cache.camada : c.camada,
    camadas: temIds ? cache.camadas : c.camadas,
    busca: temCamada ? null : c.busca,
    multiplas: temCamada ? false : c.multiplas,
    buscaSubcamada: temIds ? null : c.buscaSubcamada,
  };
}

function camadaResolvida(id) {
  const c = camadaEfetiva(id);
  const cache = base.catalogoCache[id];
  if (cache?.status === 'ok') return { url: cache.url, camada: cache.camada, camadas: cache.camadas };
  return { url: c.url, camada: c.camada, camadas: c.camadas };
}

async function verificarCamada(id) {
  const c = camadaEfetiva(id);
  if (!c || c.tipo === 'composta' || c.tipo === 'local') return { status: 'ok' };
  const r = await resolver(c);
  base.catalogoCache[id] = { ...(base.catalogoCache[id]?.manual ? { manual: true } : {}), ...r };
  base.salvarCatalogo();
  return base.catalogoCache[id];
}

function listarCatalogo() {
  return {
    grupos: GRUPOS_CAMADAS,
    camadas: CATALOGO.map((c) => {
      const e = camadaEfetiva(c.id);
      const r = camadaResolvida(c.id);
      const cache = base.catalogoCache[c.id] || {};
      return {
        id: c.id, nome: c.nome, grupos: c.grupos, fonte: c.fonte, tipo: c.tipo, info: c.info, descricao: c.descricao,
        minZoom: c.minZoom || 0, componentes: c.componentes, categoria: c.categoria, cor: c.cor,
        url: r.url || e.url, camada: r.camada, camadas: r.camadas,
        status: cache.status || 'nao_verificada', mensagem: cache.mensagem || '', verificado_em: cache.verificado_em || null,
        manual: !!cache.manual, subcamadas: cache.subcamadas || null,
        precisaResolver: (c.tipo === 'wms' && !r.camada) || (!!e.buscaSubcamada && !(r.camadas || []).length),
      };
    }),
  };
}

// ---------- CFEM ----------
async function baixarCfem() {
  const url = base.estado.config.urlCfem;
  const r = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!r.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${r.status}`);
  const { mapa, linhas } = lerCfem(Buffer.from(await r.arrayBuffer()));
  return { ...base.importarCfem(mapa, url), linhas };
}

// ---------- Rotas da API ----------
async function api(req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const r = url.pathname;
  const m = req.method;

  if (r === '/api/resumo' && m === 'GET') {
    const todos = base.todos();
    return enviarJson(res, {
      total: todos.length,
      ufs: [...base.porUf.entries()].map(([uf, l]) => ({ uf, total: l.length })).sort((a, b) => a.uf.localeCompare(b.uf)),
      monitorados: base.estado.monitorados.length,
      regioes: base.estado.regioes.length,
      alertas_nao_lidos: base.estado.alertas.filter((a) => !a.lido).length,
      importacoes: base.estado.importacoes.slice(0, 10),
      removidos: base.removidos.size,
      cfem: base.estado.cfemInfo,
      facetas: base.facetas(todos),
    });
  }

  if (r === '/api/busca' && (m === 'GET' || m === 'POST')) {
    const filtros = m === 'POST' ? await lerJson(req) : q;
    const lista = base.filtrar(filtros);
    const limite = Math.min(Number(filtros.limite) || 50, 500);
    const inicio = Number(filtros.inicio) || 0;
    return enviarJson(res, {
      total: lista.length,
      itens: lista.slice(inicio, inicio + limite).map(resumo),
      facetas: base.facetas(lista),
    });
  }

  if (r === '/api/mapa' && m === 'GET') {
    if (!q.bbox) return enviarJson(res, { erro: 'Informe bbox.' }, 400);
    const lista = base.filtrar(q);
    return enviarJson(res, {
      type: 'FeatureCollection',
      truncado: lista.length > LIMITE_MAPA,
      total: lista.length,
      features: lista.slice(0, LIMITE_MAPA).map((f) => ({ type: 'Feature', properties: f.properties, geometry: f.geometry })),
    });
  }

  if (r === '/api/processo' && m === 'GET') {
    const f = base.indice.get(q.id) || base.removidos.get(q.id);
    if (!f) return enviarJson(res, { erro: 'Processo não encontrado na base local.' }, 404);
    const mon = base.estado.monitorados.find((x) => x.processo === q.id);
    const [numero, ano] = [f.properties.numero, f.properties.ano];
    const link = base.estado.config.urlConsulta
      ? base.estado.config.urlConsulta.replace('{NUMERO}', numero).replace('{ANO}', ano).replace('{PROCESSO}', encodeURIComponent(q.id))
      : '';
    return enviarJson(res, {
      cfem: base.cfemDe(f.properties),
      cfem_ativa: base.cfemAtiva(f.properties),
      vencimento_estimado: base.vencimento(f),
      grupos: base.estado.grupos.filter((g) => g.processos.includes(q.id)).map((g) => ({ id: g.id, nome: g.nome })),
      feature: f,
      historico: base.estado.historico[q.id] || [],
      alertas: base.estado.alertas.filter((a) => a.processo === q.id),
      monitorado: mon || null,
      link_externo: link,
      vizinhos: base.filtrar({ bbox: f.bbox.join(',') }).filter((x) => x !== f).slice(0, 50).map(resumo),
    });
  }

  if (r === '/api/interferencia' && m === 'POST') {
    const { geometria } = await lerJson(req);
    if (!geometria || !/Polygon/.test(geometria.type)) return enviarJson(res, { erro: 'Envie um polígono.' }, 400);
    return enviarJson(res, base.interferencia(geometria));
  }

  if (r === '/api/exportar' && (m === 'GET' || m === 'POST')) {
    const filtros = m === 'POST' ? await lerJson(req) : q;
    const lista = filtros.ids
      ? filtros.ids.map((id) => base.indice.get(id)).filter(Boolean)
      : base.filtrar(filtros);
    const fmt = filtros.formato || 'csv';
    const nome = `processos-${new Date().toISOString().slice(0, 10)}`;
    let corpo, tipo;
    if (fmt === 'geojson') {
      corpo = JSON.stringify({ type: 'FeatureCollection', features: lista.map((f) => ({ type: 'Feature', properties: f.properties, geometry: f.geometry })) });
      tipo = 'application/geo+json';
    } else if (fmt === 'kml') { corpo = paraKml(lista); tipo = 'application/vnd.google-earth.kml+xml'; }
    else { corpo = paraCsv(lista); tipo = 'text/csv; charset=utf-8'; }
    res.writeHead(200, { 'Content-Type': tipo, 'Content-Disposition': `attachment; filename="${nome}.${fmt}"` });
    return res.end(corpo);
  }


  // Filtros (categorias prontas + filtros personalizados + grupos minerários)
  if (r === '/api/categorias' && m === 'GET') {
    return enviarJson(res, {
      grupos: GRUPOS_CATEGORIAS,
      categorias: CATEGORIAS.filter((c) => c.grupo).map(({ id, nome, grupo, nota, regra }) => ({ id, nome, grupo, nota, regra })),
      personalizados: base.estado.filtros,
      gruposMinerarios: base.estado.grupos.map((g) => ({ id: g.id, nome: g.nome, cor: g.cor, total: g.processos.length })),
      contagens: base.contarCategorias(),
    });
  }
  if (r === '/api/filtros') {
    if (m === 'POST') {
      try { return enviarJson(res, base.salvarFiltro(await lerJson(req))); }
      catch (e) { if (!e.status) e.status = 400; throw e; }
    }
    if (m === 'DELETE') {
      base.estado.filtros = base.estado.filtros.filter((f) => f.id !== q.id);
      base.salvarEstado();
      return enviarJson(res, { ok: true });
    }
  }
  if (r === '/api/grupos') {
    if (m === 'GET') return enviarJson(res, base.estado.grupos);
    if (m === 'POST') {
      const { nome, cor = '#1c7ed6', processos = [] } = await lerJson(req);
      if (!nome) return enviarJson(res, { erro: 'Informe o nome do grupo.' }, 400);
      const g = { id: 'g_' + crypto.randomUUID().slice(0, 8), nome, cor, processos, criado: new Date().toISOString() };
      base.estado.grupos.push(g);
      base.salvarEstado();
      return enviarJson(res, g);
    }
    if (m === 'PUT') {
      const { id, processo, acao = 'adicionar', nome, cor } = await lerJson(req);
      const g = base.estado.grupos.find((x) => x.id === id);
      if (!g) return enviarJson(res, { erro: 'Grupo não encontrado.' }, 404);
      if (nome) g.nome = nome;
      if (cor) g.cor = cor;
      if (processo) {
        const lista = Array.isArray(processo) ? processo : [processo];
        if (acao === 'remover') g.processos = g.processos.filter((p) => !lista.includes(p));
        else for (const p of lista) if (!g.processos.includes(p)) g.processos.push(p);
      }
      base.salvarEstado();
      return enviarJson(res, g);
    }
    if (m === 'DELETE') {
      base.estado.grupos = base.estado.grupos.filter((g) => g.id !== q.id);
      base.salvarEstado();
      return enviarJson(res, { ok: true });
    }
  }

  // Catálogo de camadas oficiais
  if (r === '/api/catalogo' && m === 'GET') return enviarJson(res, listarCatalogo());
  if (r === '/api/catalogo' && m === 'PUT') {
    const { id, url, camada, camadas, restaurar } = await lerJson(req);
    if (!camadaPorId(id)) return enviarJson(res, { erro: 'Camada desconhecida.' }, 404);
    if (restaurar) delete base.catalogoCache[id];
    else {
      if (url && !/^https?:\/\//i.test(url)) return enviarJson(res, { erro: 'URL inválida.' }, 400);
      base.catalogoCache[id] = { manual: true, url, camada, camadas: Array.isArray(camadas) ? camadas.map(Number).filter(Number.isFinite) : undefined };
    }
    base.salvarCatalogo();
    return enviarJson(res, await verificarCamada(id));
  }
  if (r === '/api/catalogo/verificar' && m === 'POST') {
    const { ids } = await lerJson(req);
    const alvo = ids?.length ? ids : CATALOGO.map((c) => c.id);
    const out = {};
    await Promise.all(alvo.map(async (id) => { out[id] = await verificarCamada(id); }));
    return enviarJson(res, out);
  }
  if (r === '/api/catalogo/consultar' && m === 'POST') {
    const { ids = [], ...ponto } = await lerJson(req);
    const resultados = [];
    await Promise.all(ids.map(async (id) => {
      const c = camadaEfetiva(id);
      if (!c || !['wms', 'arcgis'].includes(c.tipo)) return;
      try {
        const itens = await consultar(c, camadaResolvida(id), ponto);
        if (itens.length) resultados.push({ id, nome: c.nome, fonte: c.fonte, itens });
      } catch (e) { resultados.push({ id, nome: c.nome, fonte: c.fonte, erro: e.message }); }
    }));
    return enviarJson(res, resultados);
  }
  if (r === '/api/catalogo/legenda' && m === 'GET') {
    const c = camadaEfetiva(q.id);
    if (!c) return enviarJson(res, { erro: 'Camada desconhecida.' }, 404);
    try { return enviarJson(res, await legenda(c, camadaResolvida(q.id))); }
    catch (e) { return enviarJson(res, { erro: e.message }, 502); }
  }

  // CFEM (arrecadação) para a camada/filtro de minas ativas
  if (r === '/api/cfem' && m === 'POST') {
    const buf = await lerCorpo(req);
    const { mapa, linhas } = lerCfem(buf, q.modo === 'mesclar' ? base.cfem : new Map());
    return enviarJson(res, { ...base.importarCfem(mapa, q.arquivo || 'upload'), linhas });
  }
  if (r === '/api/cfem/baixar' && m === 'POST') return enviarJson(res, await baixarCfem());

  // Monitoramento de processos
  if (r === '/api/monitorados') {
    if (m === 'GET') {
      return enviarJson(res, base.estado.monitorados.map((mon) => {
        const f = base.indice.get(mon.processo);
        return { ...mon, atual: f ? resumo(f) : null, alertas_nao_lidos: base.estado.alertas.filter((a) => a.processo === mon.processo && !a.lido).length };
      }));
    }
    if (m === 'POST') {
      const { processo, nota = '', etiquetas = [] } = await lerJson(req);
      const f = base.indice.get(processo);
      let mon = base.estado.monitorados.find((x) => x.processo === processo);
      if (mon) Object.assign(mon, { nota, etiquetas });
      else {
        mon = { processo, nota, etiquetas, desde: new Date().toISOString(), snapshot: f ? { ...f.properties } : null };
        base.estado.monitorados.push(mon);
      }
      base.salvarEstado();
      return enviarJson(res, mon);
    }
    if (m === 'DELETE') {
      base.estado.monitorados = base.estado.monitorados.filter((x) => x.processo !== q.id);
      base.salvarEstado();
      return enviarJson(res, { ok: true });
    }
  }

  // Regiões de interesse
  if (r === '/api/regioes') {
    if (m === 'GET') return enviarJson(res, base.estado.regioes);
    if (m === 'POST') {
      const { nome, geometria } = await lerJson(req);
      if (!geometria) return enviarJson(res, { erro: 'Geometria obrigatória.' }, 400);
      const reg = { id: crypto.randomUUID(), nome: nome || 'Região', geometry: geometria, criada: new Date().toISOString() };
      base.estado.regioes.push(reg);
      base.salvarEstado();
      return enviarJson(res, reg);
    }
    if (m === 'DELETE') {
      base.estado.regioes = base.estado.regioes.filter((x) => x.id !== q.id);
      base.salvarEstado();
      return enviarJson(res, { ok: true });
    }
  }

  // Alertas
  if (r === '/api/alertas') {
    if (m === 'GET') {
      let lista = base.estado.alertas;
      if (q.nao_lidos === '1') lista = lista.filter((a) => !a.lido);
      return enviarJson(res, lista.slice(0, Number(q.limite) || 500));
    }
    if (m === 'POST') {
      const { ids, todos, lido = true } = await lerJson(req);
      for (const a of base.estado.alertas) if (todos || ids?.includes(a.id)) a.lido = lido;
      base.salvarEstado();
      return enviarJson(res, { ok: true });
    }
    if (m === 'DELETE') {
      base.estado.alertas = q.id ? base.estado.alertas.filter((a) => a.id !== q.id) : base.estado.alertas.filter((a) => !a.lido);
      base.salvarEstado();
      return enviarJson(res, { ok: true });
    }
  }

  // Camadas personalizadas (geologia, áreas protegidas, terras indígenas, etc.)
  if (r === '/api/camadas') {
    if (m === 'GET') return enviarJson(res, base.estado.camadas);
    if (m === 'POST') {
      const buf = await lerCorpo(req);
      const features = await lerArquivoGeo(buf, q.arquivo || '');
      return enviarJson(res, base.salvarCamada({ nome: q.nome || q.arquivo || 'Camada', cor: q.cor, grupo: q.grupo, features }));
    }
    if (m === 'DELETE') { base.removerCamada(q.id); return enviarJson(res, { ok: true }); }
  }
  if (r === '/api/camada' && m === 'GET') {
    const dados = base.lerCamada(q.id);
    if (!dados) return enviarJson(res, { erro: 'Camada não encontrada.' }, 404);
    res.writeHead(200, { 'Content-Type': 'application/geo+json' });
    return res.end(dados);
  }

  // Importação de processos
  if (r === '/api/importar' && m === 'POST') {
    const buf = await lerCorpo(req);
    const features = await lerArquivoGeo(buf, q.arquivo || '');
    return enviarJson(res, base.importarProcessos(features, {
      ufPadrao: q.uf || '', origem: q.arquivo || 'upload', substituir: q.modo !== 'mesclar',
    }));
  }
  if (r === '/api/importar/anm' && m === 'POST') {
    const { uf } = await lerJson(req);
    return enviarJson(res, await baixarAnm(uf));
  }
  if (r === '/api/uf' && m === 'DELETE') {
    base.removerUf(String(q.uf).toUpperCase());
    return enviarJson(res, { ok: true });
  }

  if (r === '/api/config') {
    if (m === 'GET') return enviarJson(res, base.estado.config);
    if (m === 'PUT') {
      const novo = await lerJson(req);
      for (const k of Object.keys(base.estado.config)) if (k in novo) base.estado.config[k] = novo[k];
      base.salvarEstado();
      agendar();
      return enviarJson(res, base.estado.config);
    }
  }

  if (r === '/api/backup' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="filao-backup.json"' });
    const { monitorados, regioes, alertas, historico, config, grupos, filtros } = base.estado;
    return res.end(JSON.stringify({ versao: 2, monitorados, regioes, alertas, historico, config, grupos, filtros }));
  }
  if (r === '/api/backup' && m === 'POST') {
    const d = await lerJson(req);
    for (const k of ['monitorados', 'regioes', 'alertas', 'historico', 'grupos', 'filtros']) if (d[k]) base.estado[k] = d[k];
    if (d.config) Object.assign(base.estado.config, d.config);
    base.salvarEstado();
    return enviarJson(res, { ok: true });
  }

  return enviarJson(res, { erro: 'Rota não encontrada.' }, 404);
}

// ---------- Atualização automática ----------
let temporizador = null;
function agendar() {
  clearInterval(temporizador);
  const h = Number(base.estado.config.atualizacaoAutomaticaHoras);
  if (!h || !base.estado.config.ufsAutomaticas?.length) return;
  temporizador = setInterval(async () => {
    for (const uf of base.estado.config.ufsAutomaticas) {
      try { console.log('[auto]', uf, await baixarAnm(uf)); } catch (e) { console.error('[auto]', uf, e.message); }
    }
  }, h * 3600 * 1000);
}

export const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' && servirEstatico(req, res, url.pathname)) return;
    res.writeHead(404); res.end('Não encontrado');
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) enviarJson(res, { erro: e.message }, e.status || 500);
    else res.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  servidor.listen(PORTA, HOST, () => {
    console.log(`Filão rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORTA}`);
    console.log(`Processos na base local: ${base.indice.size}`);
    agendar();
  });
}
