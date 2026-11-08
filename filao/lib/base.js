// Base local: processos (por UF), monitoramento, regiões, alertas, histórico e camadas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as turf from '@turf/turf';
import { normalizarProcesso } from './importador.js';

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
  // Confira o endereço vigente no portal de dados abertos da ANM antes de usar.
  urlAnm: 'https://app.anm.gov.br/dadosabertos/SIGMINE/PROCESSOS_MINERARIOS/{UF}.zip',
  // Modelo de link externo para consultar o processo. {NUMERO} e {ANO} são substituídos.
  urlConsulta: '',
  atualizacaoAutomaticaHoras: 0,
  ufsAutomaticas: [],
};

const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class Base {
  constructor(dir) {
    this.dir = dir;
    this.dirProc = path.join(dir, 'processos');
    this.dirCamadas = path.join(dir, 'camadas');
    fs.mkdirSync(this.dirProc, { recursive: true });
    fs.mkdirSync(this.dirCamadas, { recursive: true });
    this.arqEstado = path.join(dir, 'estado.json');
    this.porUf = new Map(); // UF -> Feature[]
    this.indice = new Map(); // processo -> Feature
    this.estado = {
      monitorados: [], regioes: [], alertas: [], historico: {}, camadas: [], importacoes: [],
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
      const linhas = fs.readFileSync(path.join(this.dirProc, arq), 'utf8').split('\n').filter(Boolean);
      this.porUf.set(uf, linhas.map((l) => JSON.parse(l)));
    }
    this.reindexar();
  }

  reindexar() {
    this.indice.clear();
    for (const lista of this.porUf.values()) for (const f of lista) this.indice.set(f.properties.processo, f);
  }

  salvarEstado() {
    const tmp = this.arqEstado + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.estado));
    fs.renameSync(tmp, this.arqEstado);
  }

  salvarUf(uf) {
    const lista = this.porUf.get(uf) || [];
    const arq = path.join(this.dirProc, `${uf}.ndjson`);
    fs.writeFileSync(arq + '.tmp', lista.map((f) => JSON.stringify(f)).join('\n'));
    fs.renameSync(arq + '.tmp', arq);
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

    // Histórico de alterações de todos os processos que mudaram
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

    // Processos monitorados
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

    // Regiões monitoradas: novos processos que tocam a região
    for (const reg of this.estado.regioes) {
      const bb = turf.bbox(reg.geometry);
      for (const f of novos) {
        if (antes.has(f.properties.processo)) continue;
        if (!bboxCruza(bb, f.bbox)) continue;
        try {
          if (turf.booleanIntersects(reg.geometry, f.geometry)) {
            alertas.push(this.novoAlerta('regiao', f.properties.processo,
              `Novo processo na região "${reg.nome}": ${f.properties.fase || 'fase n/d'}, ${f.properties.substancia || 'substância n/d'}, ${f.properties.titular || 'titular n/d'}.`));
          }
        } catch { /* geometria inválida: ignora */ }
      }
    }

    const resumo = {
      data: agora, origem, ufs: ufsAfetadas, total: novos.length,
      novos: novos.filter((f) => !antes.has(f.properties.processo)).length,
      alterados, alertas: alertas.length,
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
    this.reindexar();
  }

  // ---------- Busca ----------
  filtrar(q = {}) {
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
    const bbox = q.bbox ? String(q.bbox).split(',').map(Number) : null;
    const somenteMon = q.monitorados === '1';
    const setMon = new Set(this.estado.monitorados.map((m) => m.processo));
    let geo = null;
    if (q.geometria) {
      geo = typeof q.geometria === 'string' ? JSON.parse(q.geometria) : q.geometria;
    }
    const geoBbox = geo ? turf.bbox(geo) : null;

    const fontes = ufs.length ? ufs.map((u) => this.porUf.get(u) || []) : [...this.porUf.values()];
    const out = [];
    for (const lista of fontes) {
      for (const f of lista) {
        const p = f.properties;
        if (bbox && !bboxCruza(bbox, f.bbox)) continue;
        if (proc && !(p.numero + String(p.ano)).includes(proc) && !p.processo.replace(/\D/g, '').includes(proc)) continue;
        if (fases.length && !fases.includes(p.fase)) continue;
        if (usos.length && !usos.includes(p.uso)) continue;
        if (p.ano && (p.ano < anoMin || p.ano > anoMax)) continue;
        if (p.area_ha < areaMin || p.area_ha > areaMax) continue;
        if (titular && !sem(p.titular).includes(titular)) continue;
        if (subs && !sem(p.substancia).includes(subs)) continue;
        if (evento && !sem(p.ult_evento).includes(evento)) continue;
        if (somenteMon && !setMon.has(p.processo)) continue;
        if (termo) {
          const alvo = sem(`${p.processo} ${p.titular} ${p.substancia} ${p.fase} ${p.ult_evento} ${p.uso} ${p.uf}`);
          if (!termo.split(/\s+/).every((t) => alvo.includes(t))) continue;
        }
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
      if (areaInter <= 0.0001 && !inter) continue;
      itens.push({
        ...f.properties,
        area_sobreposta_ha: Math.round(areaInter * 100) / 100,
        perc_do_alvo: areaAlvo ? Math.round((areaInter / areaAlvo) * 10000) / 100 : 0,
        perc_do_processo: f.properties.area_ha ? Math.round((areaInter / f.properties.area_ha) * 10000) / 100 : 0,
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

function listaParam(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim().toUpperCase()).filter(Boolean);
}

export function bboxCruza(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

const arred = (n) => Math.round(n * 100) / 100;
