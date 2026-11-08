// Leitura de arquivos geográficos (Shapefile em .zip, GeoJSON, KML/KMZ)
// e normalização dos atributos do SIGMINE/ANM.
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import { DOMParser } from '@xmldom/xmldom';
import * as turf from '@turf/turf';

// Converte qualquer arquivo suportado em uma lista de Features GeoJSON.
export async function lerArquivoGeo(buffer, nomeArquivo = '') {
  const nome = nomeArquivo.toLowerCase();
  if (nome.endsWith('.zip') || ehZip(buffer)) return lerZip(buffer);
  if (nome.endsWith('.kmz')) {
    const zip = new AdmZip(buffer);
    const kmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.kml'));
    if (!kmlEntry) throw new Error('KMZ sem arquivo .kml interno.');
    return lerKml(kmlEntry.getData().toString('utf8'));
  }
  const texto = buffer.toString('utf8').replace(/^﻿/, '');
  if (nome.endsWith('.kml') || texto.trimStart().startsWith('<')) return lerKml(texto);
  const json = JSON.parse(texto);
  if (json.type === 'FeatureCollection') return json.features;
  if (json.type === 'Feature') return [json];
  if (json.type && json.coordinates) return [{ type: 'Feature', properties: {}, geometry: json }];
  throw new Error('JSON não reconhecido como GeoJSON.');
}

function ehZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function lerKml(texto) {
  const doc = new DOMParser().parseFromString(texto, 'text/xml');
  return kmlToGeoJSON(doc).features.filter((f) => f.geometry);
}

async function lerZip(buffer) {
  const zip = new AdmZip(buffer);
  const entradas = zip.getEntries();
  const features = [];
  const shps = entradas.filter((e) => e.entryName.toLowerCase().endsWith('.shp'));
  for (const shp of shps) {
    const base = shp.entryName.slice(0, -4).toLowerCase();
    const achar = (ext) => entradas.find((e) => e.entryName.toLowerCase() === base + ext);
    const dbf = achar('.dbf');
    const prj = achar('.prj');
    const cpg = achar('.cpg');
    if (prj) {
      const txt = prj.getData().toString('utf8');
      if (/PROJCS/i.test(txt)) {
        throw new Error(`O shapefile ${shp.entryName} está em coordenadas projetadas (UTM etc.). Reprojete para SIRGAS 2000 geográfico (EPSG:4674) ou WGS84 antes de importar.`);
      }
    }
    let encoding = 'windows-1252';
    if (cpg) {
      const c = cpg.getData().toString('utf8').trim().toLowerCase();
      if (c.includes('utf')) encoding = 'utf-8';
    }
    const fonte = await shapefile.open(
      toArrayBuffer(shp.getData()),
      dbf ? toArrayBuffer(dbf.getData()) : undefined,
      { encoding }
    );
    for (;;) {
      const r = await fonte.read();
      if (r.done) break;
      if (r.value && r.value.geometry) features.push(r.value);
    }
  }
  if (!shps.length) {
    for (const e of entradas) {
      const n = e.entryName.toLowerCase();
      if (n.endsWith('.geojson') || n.endsWith('.json') || n.endsWith('.kml')) {
        features.push(...(await lerArquivoGeo(e.getData(), n)));
      }
    }
  }
  if (!features.length) throw new Error('Nenhuma geometria encontrada no .zip.');
  return features;
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// Busca um atributo ignorando maiúsculas/minúsculas e acentos.
function campo(props, ...nomes) {
  const chaves = Object.keys(props);
  for (const n of nomes) {
    const alvo = n.toLowerCase();
    const k = chaves.find((c) => c.toLowerCase() === alvo);
    if (k !== undefined && props[k] !== null && props[k] !== '') return props[k];
  }
  return undefined;
}

const limpar = (v) => (v === undefined || v === null ? '' : String(v).trim());

// Normaliza uma feature de processo minerário (padrão SIGMINE).
export function normalizarProcesso(f) {
  const p = f.properties || {};
  let processo = limpar(campo(p, 'PROCESSO', 'processo', 'DSProcesso', 'NUM_PROC'));
  let numero = limpar(campo(p, 'NUMERO', 'NUM'));
  let ano = limpar(campo(p, 'ANO'));
  if (!processo && numero && ano) processo = `${numero.replace(/^(\d{3})(\d{3})$/, '$1.$2')}/${ano}`;
  const m = processo.match(/(\d{3})\.?(\d{3})\s*\/\s*(\d{4})/);
  if (m) {
    processo = `${m[1]}.${m[2]}/${m[3]}`;
    numero = numero || m[1] + m[2];
    ano = ano || m[3];
  }
  if (!processo || !f.geometry) return null;
  let area = Number(String(campo(p, 'AREA_HA', 'AREA') ?? '').replace(',', '.'));
  if (!Number.isFinite(area) || area <= 0) {
    try { area = turf.area(f) / 10000; } catch { area = 0; }
  }
  let bbox;
  try { bbox = turf.bbox(f); } catch { return null; }
  if (bbox.some((v) => !Number.isFinite(v)) || Math.abs(bbox[0]) > 180 || Math.abs(bbox[1]) > 90) return null;
  const ultEvento = limpar(campo(p, 'ULT_EVENTO', 'ULTIMO_EVENTO', 'EVENTO'));
  return {
    type: 'Feature',
    bbox,
    properties: {
      processo,
      numero: limpar(numero),
      ano: Number(ano) || null,
      area_ha: Math.round(area * 100) / 100,
      fase: limpar(campo(p, 'FASE')).toUpperCase(),
      ult_evento: ultEvento,
      data_evento: dataDoEvento(ultEvento),
      titular: limpar(campo(p, 'NOME', 'TITULAR', 'REQUERENTE')),
      substancia: limpar(campo(p, 'SUBS', 'SUBSTANCIA')).toUpperCase(),
      uso: limpar(campo(p, 'USO')).toUpperCase(),
      uf: limpar(campo(p, 'UF')).toUpperCase(),
    },
    geometry: f.geometry,
  };
}

// Extrai a data (dd/mm/aaaa) do texto do último evento, quando houver.
export function dataDoEvento(texto) {
  const m = String(texto || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
