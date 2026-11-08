// Base local: processos (por UF), monitoramento, regiões, alertas, histórico, grupos,
// filtros personalizados, áreas que saíram da base, CFEM e camadas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as turf from '@turf/turf';
import { normalizarProcesso, dataDoEvento } from './importador.js';
import { CATEGORIAS, compilarRegra, validarRegra, semAcento } from './categorias.js';

const CAMPOS_MONITORADOS = {
  fase: 'Fase',
  ult_evento: 'Último evento',
  titular: 'Titular',
  substancia: 'Substância',
  area_ha: 'Área (ha)',
  uso: 'Uso',
};

export const CONFIG_PADRAO = {
  // Modelo de URL para baixar o shapefile oficial por UF. {UF} é substituído.
  urlAnm: 'https://app.anm.gov.br/dadosabertos/SIGMINE/PROCESSOS_MINERARIOS/{UF}.zip',
  // Planilha de arrecadação da CFEM (dados abertos ANM). Confira o endereço vigente.
  urlCfem: 'https://app.anm.gov.br/dadosabertos/ARRECADACAO/CFEM_Arrecadacao.csv',
  urlConsulta: '',
  atualizacaoAutomaticaHoras: 0,
  ufsAutomaticas: [],
  diasRecente: 30,
  prazoAlvaraAnos: 3,
  diasAvisoVencimento: 180,
  mesesCfem: 24,
  diasManterRemovidos: 730,
};

const CELULA = 0.5; // graus, para o índice espacial em grade

export class Base {
  constructor(dir) {
    this.dir = dir;
    this.dirProc = path.join(dir, 'processos');
    this.dirCamadas = path.join(dir, 'camadas');
    fs.mkdirSync(this.dirProc, { recursive: true });
    fs.mkdirSync(this.dirCamadas, { recursive: true });
    this.arqEstado = path.join(dir, 'estado.json');
    this.arqRemovidos = path.join(dir, 'removidos.ndjson');
    this.arqCfem = path.join(dir, 'cfem.json');
    this.arqCatalogo = path.join(dir, 'catalogo.json');
    this.porUf = new Map();
    this.indice = new Map();
    this.grade = new Map();
    this.removidos = new Map();
    this.cfem = new Map();
    this.catalogoCache = {};
    this.estado = {
      monitorados: [], regioes: [], alertas: [], historico: {}, camadas: [], importacoes: [],
      grupos: [], filtros: [], cfemInfo: null,
      config: { ...CONFIG_PADRAO },
    };
    this.carregar();
  }

  carregar() {
    if (fs.existsSync(this.arqEstado)) {
      const e = JSON.parse(fs.readFileSync(this.arqEstado, 'utf8'));
      this.estado = { ...this.estado, ...e, config: { ...CONFIG_PADRAO, ...(e.config || {}) } };
    }
    for (const arq of fs.readdirSync(this.dirProc)) {
      if (!arq.endsWith('.ndjson')) continue;
      const uf = arq.replace('.ndjson', '');
      this.porUf.set(uf, lerNdjson(path.join(this.dirProc, arq)));
    }
    if (fs.existsSync(this.arqRemovidos)) for (const f of lerNdjson(this.arqRemovidos)) this.removidos.set(f.properties.processo, f);
    if (fs.existsSync(this.arqCfem)) this.cfem = new Map(Object.entries(JSON.parse(fs.readFileSync(this.arqCfem, 'utf8'))));
    if (fs.existsSync(this.arqCatalogo)) this.catalogoCache = JSON.parse(fs.readFileSync(this.arqCatalogo, 'utf8'));
    this.reindexar();
  }

  reindexar() {
    this.indice.clear();
    this.grade.clear();
    for (const lista of this.porUf.values()) {
      for (const f of lista) {
        this.indice.set(f.properties.processo, f);
        for (const k of celulas(f.bbox) || [`${Math.floor(f.bbox[0] / CELULA)}:${Math.floor(f.bbox[1] / CELULA)}`]) {
          if (!this.grade.has(k)) this.grade.set(k, []);
          this.grade.get(k).push(f);
        }
      }
    }
  }

  // Processos ativos cujo bbox cruza o bbox informado (usa a grade)
  candidatos(bbox) {
    const vistos = new Set();
    const out = [];
    const ks = celulas(bbox);
    if (!ks) {
      for (const f of this.indice.values()) if (bboxCruza(bbox, f.bbox)) out.push(f);
      return out;
    }
    for (const k of ks) {
      for (const f of this.grade.get(k) || []) {
        if (vistos.has(f)) continue;
        vistos.add(f);
        if (bboxCruza(bbox, f.bbox)) out.push(f);
      }
    }
    return out;
  }

  salvarEstado() {
    escreverAtomico(this.arqEstado, JSON.stringify(this.estado));
  }

  salvarUf(uf) {
    escreverAtomico(path.join(this.dirProc, `${uf}.ndjson`), (this.porUf.get(uf) || []).map((f) => JSON.stringify(f)).join('\n'));
  }

  salvarRemovidos() {
    escreverAtomico(this.arqRemovidos, [...this.removidos.values()].map((f) => JSON.stringify(f)).join('\n'));
  }

  salvarCatalogo() {
    escreverAtomico(this.arqCatalogo, JSON.stringify(this.catalogoCache, null, 1));
  }

  todos() {
    const out = [];
    for (const l of this.porUf.values()) out.push(...l);
    return out;
  }

  // ---------- Importação com detecção de mudanças ----------
  importarProcessos(featuresBrutas, { ufPadrao = '', origem = 'arquivo', substituir = true } = {}) {
    const novos = featuresBrutas.map(normalizarProcesso).filter(Boolean);
    if (!novos.length) throw new Error('Nenhum processo válido encontrado (é preciso o atributo PROCESSO ou NUMERO+ANO).');
    for (const f of novos) if (!f.properties.uf) f.properties.uf = ufPadrao.toUpperCase() || 'XX';

    const grupos = new Map();
    for (const f of novos) {
      const uf = f.properties.uf.split(/[\/,; ]/)[0] || 'XX';
      if (!grupos.has(uf)) grupos.set(uf, []);
      grupos.get(uf).push(f);
    }

    const antes = new Map(this.indice);
    const agora = new Date().toISOString();
    const alertas = [];
    const ufsAfetadas = [...grupos.keys()];
    const ufsComDados = new Set(ufsAfetadas.filter((u) => (this.porUf.get(u) || []).length));
    const setNovos = new Set(novos.map((f) => f.properties.processo));

    // Data em que cada processo apareceu pela primeira vez (null na primeira carga da UF)
    for (const f of novos) {
      const ant = antes.get(f.properties.processo);
      f.properties.visto_em = ant ? (ant.properties.visto_em ?? null) : (ufsComDados.has(f.properties.uf) ? agora : null);
      if (ant?.properties.alvara_em) f.properties.alvara_em = ant.properties.alvara_em;
      if (/ALVARA.*PUBLICAD/.test(semAcento(f.properties.ult_evento)) && f.properties.data_evento) {
        f.properties.alvara_em = f.properties.data_evento;
      }
    }

    // Processos que saíram da base (somente quando a UF é substituída)
    const saíram = [];
    if (substituir) {
      for (const uf of ufsAfetadas) {
        for (const f of this.porUf.get(uf) || []) {
          if (!setNovos.has(f.properties.processo)) saíram.push(f);
        }
      }
    }

    for (const [uf, lista] of grupos) {
      if (substituir) this.porUf.set(uf, lista);
      else {
        const mapa = new Map((this.porUf.get(uf) || []).map((f) => [f.properties.processo, f]));
        for (const f of lista) mapa.set(f.properties.processo, f);
        this.porUf.set(uf, [...mapa.values()]);
      }
      this.salvarUf(uf);
    }
    this.reindexar();

    // Atualiza registro de áreas que saíram da base e recalcula se continuam livres
    for (const f of saíram) {
      this.removidos.set(f.properties.processo, {
        ...f, properties: { ...f.properties, removido_em: agora, situacao: 'SAIU DA BASE ATIVA' },
      });
    }
    for (const p of setNovos) this.removidos.delete(p);
    const limite = Date.now() - this.estado.config.diasManterRemovidos * 864e5;
    for (const [k, f] of this.removidos) {
      if (Date.parse(f.properties.removido_em) < limite) { this.removidos.delete(k); continue; }
      f.properties.livre = !this.candidatos(f.bbox).some((a) => {
        try { return turf.booleanIntersects(a.geometry, f.geometry); } catch { return false; }
      });
    }
    this.salvarRemovidos();

    let alterados = 0;
    for (const f of novos) {
      const ant = antes.get(f.properties.processo);
      if (!ant) continue;
      const mud = diferencas(ant.properties, f.properties);
      if (mud.length) {
        alterados++;
        const h = (this.estado.historico[f.properties.processo] ||= []);
        for (const m of mud) h.push({ data: agora, ...m });
      }
    }

    for (const mon of this.estado.monitorados) {
      const ant = antes.get(mon.processo);
      const novo = this.indice.get(mon.processo);
      if (novo) {
        const base = mon.snapshot || ant?.properties;
        const mud = base ? diferencas(base, novo.properties) : [];
        for (const m of mud) {
          alertas.push(this.novoAlerta('alteracao', mon.processo,
            `${CAMPOS_MONITORADOS[m.campo]}: "${m.de || '—'}" → "${m.para || '—'}"`));
        }
        mon.snapshot = { ...novo.properties };
      } else if (ant && substituir && ufsAfetadas.includes(ant.properties.uf)) {
        alertas.push(this.novoAlerta('removido', mon.processo,
          'O processo não consta mais na base ativa importada (verifique arquivamento, extinção ou mudança de numeração).'));
      }
    }

    for (const reg of this.estado.regioes) {
      const bb = turf.bbox(reg.geometry);
      for (const f of novos) {
        if (antes.has(f.properties.processo) || !bboxCruza(bb, f.bbox)) continue;
        try {
          if (turf.booleanIntersects(reg.geometry, f.geometry)) {
            alertas.push(this.novoAlerta('regiao', f.properties.processo,
              `Novo processo na região "${reg.nome}": ${f.properties.fase || 'fase n/d'}, ${f.properties.substancia || 'substância n/d'}, ${f.properties.titular || 'titular n/d'}.`));
          }
        } catch { /* geometria inválida */ }
      }
      for (const f of saíram) {
        const r = this.removidos.get(f.properties.processo);
        if (!r?.properties.livre || !bboxCruza(bb, f.bbox)) continue;
        try {
          if (turf.booleanIntersects(reg.geometry, f.geometry)) {
            alertas.push(this.novoAlerta('livre', f.properties.processo,
              `Área possivelmente liberada na região "${reg.nome}" (${fmtHa(f.properties.area_ha)} ha, ${f.properties.substancia || 's/ substância'}).`));
          }
        } catch { /* ignora */ }
      }
    }

    const resumo = {
      data: agora, origem, ufs: ufsAfetadas, total: novos.length,
      novos: novos.filter((f) => !antes.has(f.properties.processo)).length,
      alterados, sairam: saíram.length, alertas: alertas.length,
    };
    this.estado.importacoes.unshift(resumo);
    this.estado.importacoes = this.estado.importacoes.slice(0, 100);
    this.estado.alertas.unshift(...alertas);
    this.estado.alertas = this.estado.alertas.slice(0, 5000);
    this.salvarEstado();
    return resumo;
  }

  novoAlerta(tipo, processo, mensagem) {
    return { id: crypto.randomUUID(), data: new Date().toISOString(), tipo, processo, mensagem, lido: false };
  }

  removerUf(uf) {
    this.porUf.delete(uf);
    fs.rmSync(path.join(this.dirProc, `${uf}.ndjson`), { force: true });
    for (const [k, f] of this.removidos) if (f.properties.uf === uf) this.removidos.delete(k);
    this.salvarRemovidos();
    this.reindexar();
  }

  // ---------- CFEM ----------
  importarCfem(mapa, origem) {
    this.cfem = mapa;
    fs.writeFileSync(this.arqCfem, JSON.stringify(Object.fromEntries(mapa)));
    const ativos = this.todos().filter((f) => this.cfemAtiva(f.properties)).length;
    this.estado.cfemInfo = { data: new Date().toISOString(), origem, processos: mapa.size, ativos_na_base: ativos };
    this.salvarEstado();
    return this.estado.cfemInfo;
  }

  cfemDe(p) {
    return this.cfem.get(`${String(p.numero).replace(/\D/g, '').padStart(6, '0')}/${p.ano}`) || null;
  }

  cfemAtiva(p) {
    const c = this.cfemDe(p);
    if (!c || !c.ultimo) return false;
    const [a, m] = c.ultimo.split('-').map(Number);
    const meses = (new Date().getFullYear() - a) * 12 + (new Date().getMonth() + 1 - m);
    return meses <= this.estado.config.mesesCfem;
  }

  // Estimativa de vencimento do alvará de pesquisa
  vencimento(f) {
    const p = f.properties;
    if (!/AUTORIZACAO DE PESQUISA/.test(semAcento(p.fase))) return null;
    let data = p.alvara_em;
    if (!data) {
      const h = (this.estado.historico[p.processo] || []).filter((x) => x.campo === 'ult_evento' && /ALVARA.*PUBLICAD/.test(semAcento(x.para)));
      if (h.length) data = dataDoEvento(h.at(-1).para);
    }
    if (!data) return null;
    const d = new Date(data);
    d.setFullYear(d.getFullYear() + Number(this.estado.config.prazoAlvaraAnos || 3));
    return d.toISOString().slice(0, 10);
  }

  // ---------- Filtros ----------
  categoria(id) {
    const c = CATEGORIAS.find((x) => x.id === id);
    if (c) return c;
    return this.estado.filtros.find((x) => x.id === id) || null;
  }

  contexto() {
    return {
      agora: Date.now(), config: this.estado.config,
      vencimento: (f) => this.vencimento(f), cfemAtiva: (p) => this.cfemAtiva(p),
    };
  }

  // Predicado para os campos do formulário de busca
  predicado(q = {}) {
    const sem = (s) => semAcento(s).toLowerCase();
    const termo = sem(q.q);
    const proc = String(q.processo || '').replace(/\D/g, '');
    const titular = sem(q.titular);
    const subs = sem(q.substancia);
    const fases = listaParam(q.fase);
    const ufs = listaParam(q.uf);
    const usos = listaParam(q.uso);
    const evento = sem(q.evento);
    const anoMin = Number(q.ano_min) || 0;
    const anoMax = Number(q.ano_max) || 9999;
    const areaMin = Number(q.area_min) || 0;
    const areaMax = Number(q.area_max) || Infinity;
    const somenteMon = q.monitorados === '1' || q.monitorados === true;
    const setMon = new Set(this.estado.monitorados.map((m) => m.processo));
    const grupos = listaParam(q.grupo, false);
    const setGrupo = grupos.length
      ? new Set(this.estado.grupos.filter((g) => grupos.includes(g.id)).flatMap((g) => g.processos))
      : null;
    return (f) => {
      const p = f.properties;
      if (proc && !(p.numero + String(p.ano)).includes(proc) && !p.processo.replace(/\D/g, '').includes(proc)) return false;
      if (fases.length && !fases.includes(p.fase)) return false;
      if (ufs.length && !ufs.includes(p.uf)) return false;
      if (usos.length && !usos.includes(p.uso)) return false;
      if (p.ano && (p.ano < anoMin || p.ano > anoMax)) return false;
      if (p.area_ha < areaMin || p.area_ha > areaMax) return false;
      if (titular && !sem(p.titular).includes(titular)) return false;
      if (subs && !sem(p.substancia).includes(subs)) return false;
      if (evento && !sem(p.ult_evento).includes(evento)) return false;
      if (somenteMon && !setMon.has(p.processo)) return false;
      if (setGrupo && !setGrupo.has(p.processo)) return false;
      if (termo) {
        const alvo = sem(`${p.processo} ${p.titular} ${p.substancia} ${p.fase} ${p.ult_evento} ${p.uso} ${p.uf}`);
        if (!termo.split(/\s+/).every((t) => alvo.includes(t))) return false;
      }
      return true;
    };
  }

  filtrar(q = {}) {
    const bbox = q.bbox ? String(q.bbox).split(',').map(Number) : null;
    const geo = q.geometria ? (typeof q.geometria === 'string' ? JSON.parse(q.geometria) : q.geometria) : null;
    const geoBbox = geo ? turf.bbox(geo) : null;
    const ctx = this.contexto();

    // Categorias marcadas: combinação "OU" entre elas
    const ids = listaParam(q.categorias, false);
    const preds = ids.map((id) => {
      const c = this.categoria(id);
      if (!c) return null;
      const regra = compilarRegra(c.regra || {});
      const extra = c.parametros ? this.predicado(c.parametros) : null;
      return (f) => regra(f, ctx) && (!extra || extra(f));
    }).filter(Boolean);
    const querLivres = ids.some((id) => this.categoria(id)?.regra?.especial === 'livre');
    const doFormulario = this.predicado(q);

    let fontes;
    if (bbox) fontes = [this.candidatos(bbox)];
    else if (geoBbox) fontes = [this.candidatos(geoBbox)];
    else {
      const ufs = listaParam(q.uf);
      fontes = ufs.length ? ufs.map((u) => this.porUf.get(u) || []) : [...this.porUf.values()];
    }
    if (querLivres) fontes.push([...this.removidos.values()].filter((f) => (!bbox || bboxCruza(bbox, f.bbox))));

    const out = [];
    for (const lista of fontes) {
      for (const f of lista) {
        if (bbox && !bboxCruza(bbox, f.bbox)) continue;
        if (preds.length && !preds.some((fn) => fn(f))) continue;
        if (!doFormulario(f)) continue;
        if (geo) {
          if (!bboxCruza(geoBbox, f.bbox)) continue;
          try { if (!turf.booleanIntersects(geo, f.geometry)) continue; } catch { continue; }
        }
        out.push(f);
      }
    }
    const ord = q.ordem || 'processo';
    const dir = q.dir === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      const x = a.properties[ord], y = b.properties[ord];
      if (typeof x === 'number' || typeof y === 'number') return ((x || 0) - (y || 0)) * dir;
      return String(x || '').localeCompare(String(y || ''), 'pt-BR') * dir;
    });
    return out;
  }

  contarCategorias() {
    const chave = JSON.stringify([this.estado.importacoes[0]?.data, this.estado.filtros, this.estado.config, this.estado.cfemInfo?.data, this.indice.size, this.removidos.size]);
    if (this._contagens?.chave === chave) return { ...this._contagens.res, ...this.contarGrupos() };
    const ctx = this.contexto();
    const todos = this.todos();
    const res = {};
    for (const c of [...CATEGORIAS, ...this.estado.filtros]) {
      const regra = compilarRegra(c.regra || {});
      const extra = c.parametros ? this.predicado(c.parametros) : null;
      const lista = c.regra?.especial === 'livre' ? [...this.removidos.values()] : todos;
      res[c.id] = lista.reduce((n, f) => n + (regra(f, ctx) && (!extra || extra(f)) ? 1 : 0), 0);
    }
    this._contagens = { chave, res };
    return { ...res, ...this.contarGrupos() };
  }

  contarGrupos() {
    return Object.fromEntries(this.estado.grupos.map((g) => ['grupo:' + g.id, g.processos.length]));
  }

  salvarFiltro({ id, nome, regra = {}, parametros = {} }) {
    if (!nome) throw new Error('Dê um nome ao filtro.');
    validarRegra(regra);
    const limpo = Object.fromEntries(Object.entries(parametros).filter(([, v]) => v !== '' && v != null));
    const existente = id && this.estado.filtros.find((f) => f.id === id);
    if (existente) Object.assign(existente, { nome, regra, parametros: limpo });
    else this.estado.filtros.push({ id: 'f_' + crypto.randomUUID().slice(0, 8), nome, regra, parametros: limpo, grupo: 'Meus filtros' });
    this.salvarEstado();
    return existente || this.estado.filtros.at(-1);
  }

  facetas(lista) {
    const conta = (campo, max = 50) => {
      const m = new Map();
      for (const f of lista) {
        const v = f.properties[campo] || '(sem informação)';
        m.set(v, (m.get(v) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([valor, qtd]) => ({ valor, qtd }));
    };
    return {
      fase: conta('fase'), uf: conta('uf'), substancia: conta('substancia', 30),
      titular: conta('titular', 30), uso: conta('uso'),
      area_total_ha: Math.round(lista.reduce((s, f) => s + (f.properties.area_ha || 0), 0)),
    };
  }

  // ---------- Interferência / área livre ----------
  interferencia(geometria) {
    const alvo = turf.feature(geometria);
    const areaAlvo = turf.area(alvo) / 10000;
    const candidatos = this.filtrar({ geometria });
    const itens = [];
    let uniao = null;
    for (const f of candidatos) {
      let inter = null;
      try { inter = turf.intersect(turf.featureCollection([alvo, turf.feature(f.geometry)])); } catch { /* ignora */ }
      const areaInter = inter ? turf.area(inter) / 10000 : 0;
      itens.push({
        ...f.properties,
        area_sobreposta_ha: arred(areaInter),
        perc_do_alvo: areaAlvo ? arred((areaInter / areaAlvo) * 100) : 0,
        perc_do_processo: f.properties.area_ha ? arred((areaInter / f.properties.area_ha) * 100) : 0,
      });
      if (inter) {
        try { uniao = uniao ? turf.union(turf.featureCollection([uniao, inter])) : inter; } catch { /* ignora */ }
      }
    }
    let livre = alvo;
    if (uniao) {
      try { livre = turf.difference(turf.featureCollection([alvo, uniao])); } catch { /* ignora */ }
    }
    const areaLivre = livre ? turf.area(livre) / 10000 : 0;
    itens.sort((a, b) => b.area_sobreposta_ha - a.area_sobreposta_ha);
    return {
      area_alvo_ha: arred(areaAlvo),
      area_ocupada_ha: arred(areaAlvo - areaLivre),
      area_livre_ha: arred(areaLivre),
      perc_livre: areaAlvo ? arred((areaLivre / areaAlvo) * 100) : 0,
      perimetro_km: arred(turf.length(turf.polygonToLine(alvo), { units: 'kilometers' })),
      centroide: turf.centroid(alvo).geometry.coordinates,
      interferencias: itens,
      geometria_livre: livre,
      geometria_ocupada: uniao,
    };
  }

  // ---------- Camadas personalizadas ----------
  salvarCamada({ nome, cor, grupo, features }) {
    const id = crypto.randomUUID();
    const fc = { type: 'FeatureCollection', features: features.filter((f) => f && f.geometry) };
    fs.writeFileSync(path.join(this.dirCamadas, `${id}.geojson`), JSON.stringify(fc));
    const meta = { id, nome, cor: cor || '#e8590c', grupo: grupo || 'Minhas camadas', total: fc.features.length, criada: new Date().toISOString() };
    this.estado.camadas.push(meta);
    this.salvarEstado();
    return meta;
  }

  lerCamada(id) {
    if (!/^[\w-]+$/.test(id)) return null;
    const arq = path.join(this.dirCamadas, `${id}.geojson`);
    return fs.existsSync(arq) ? fs.readFileSync(arq) : null;
  }

  removerCamada(id) {
    this.estado.camadas = this.estado.camadas.filter((c) => c.id !== id);
    if (/^[\w-]+$/.test(id)) fs.rmSync(path.join(this.dirCamadas, `${id}.geojson`), { force: true });
    this.salvarEstado();
  }
}

function diferencas(a, b) {
  const out = [];
  for (const c of Object.keys(CAMPOS_MONITORADOS)) {
    const x = a[c] ?? '', y = b[c] ?? '';
    if (c === 'area_ha' ? Math.abs(Number(x) - Number(y)) > 0.01 : String(x) !== String(y)) {
      out.push({ campo: c, de: x, para: y });
    }
  }
  return out;
}

function listaParam(v, maiusculas = true) {
  if (!v) return [];
  return (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).map((s) => (maiusculas ? s.toUpperCase() : s)).filter(Boolean);
}

// Células da grade cobertas por um bbox (null se forem muitas)
function celulas(bb) {
  const x0 = Math.floor(bb[0] / CELULA), x1 = Math.floor(bb[2] / CELULA);
  const y0 = Math.floor(bb[1] / CELULA), y1 = Math.floor(bb[3] / CELULA);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 5000) return null;
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x}:${y}`);
  return out;
}

function lerNdjson(arq) {
  return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function escreverAtomico(arq, texto) {
  fs.writeFileSync(arq + '.tmp', texto);
  fs.renameSync(arq + '.tmp', arq);
}

export function bboxCruza(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

const arred = (n) => Math.round(n * 100) / 100;
const fmtHa = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
