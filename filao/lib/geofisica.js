// Processamento de dados aerogeofísicos (magnetometria e gamaespectrometria).
// Entrada: dados de linha XYZ/CSV (ex.: projetos do SGB/GeoSGB) ou grades GeoTIFF/ESRI ASCII.
// Saída: grades interpoladas e produtos derivados recortados na área de interesse.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import * as turf from '@turf/turf';
import { PNG } from 'pngjs';
import AdmZip from 'adm-zip';
import { paraUtm, deUtm, zonaDe, interpretarEpsg, wktUtm, WKT_GEO } from './projecao.js';

export const CANAIS = {
  mag: { nome: 'Magnetometria (campo anômalo)', unidade: 'nT', re: /^(MAGIGRF|MAGNIV|MAGMIC|MAGCOR|MAGIGRFR|MAGANOM|MAGRES|TMI|CMA|MAGFINAL|MAG)$/ },
  k: { nome: 'Potássio', unidade: '%', re: /^(KPERC|KPC|KPCT|K|POTASSIO|KCONC)$/ },
  th: { nome: 'Tório', unidade: 'ppm', re: /^(ETH|THPPM|ETHPPM|TH|TORIO|THCONC)$/ },
  u: { nome: 'Urânio', unidade: 'ppm', re: /^(EU|UPPM|EUPPM|U|URANIO|UCONC)$/ },
  ct: { nome: 'Contagem total', unidade: 'µR/h', re: /^(CTCOR|CTEXP|CT|CTEX|TC|CTOTAL|DOSE)$/ },
};
const RE_LON = /^(LONG|LONGITUDE|LON|LNG|LONGWGS|LONGSIRGAS|LONGSAD)$/;
const RE_LAT = /^(LAT|LATITUDE|LATWGS|LATSIRGAS|LATSAD)$/;
const RE_X = /^(X|UTME|UTMX|EAST|EASTING|E|XUTM|XSIRGAS|XWGS|XSAD|XSAD69)$/;
const RE_Y = /^(Y|UTMN|UTMY|NORTH|NORTHING|N|YUTM|YSIRGAS|YWGS|YSAD|YSAD69)$/;

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ehNumero = (s) => s !== '' && s !== '*' && Number.isFinite(Number(s));

// Vetor tipado que cresce
class Vetor {
  constructor(Tipo = Float64Array) { this.T = Tipo; this.d = new Tipo(1 << 16); this.n = 0; }
  push(v) {
    if (this.n === this.d.length) { const nv = new this.T(this.d.length * 2); nv.set(this.d); this.d = nv; }
    this.d[this.n++] = v;
  }
  final() { return this.d.subarray(0, this.n); }
}

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------
export async function importarLevantamento(dirBase, arqTemp, { nome, nomeArquivo = '', zona, sul = true, canal, epsg } = {}) {
  const ext = path.extname(nomeArquivo).toLowerCase();
  let canais;
  if (ext === '.tif' || ext === '.tiff') canais = await lerGeoTiff(arqTemp, { canal, zona, sul, epsg });
  else if (ext === '.asc') canais = lerAsc(arqTemp, { canal, zona, sul, epsg });
  else canais = await lerXyz(arqTemp, { zona, sul, epsg });

  const id = 'lev_' + crypto.randomUUID().slice(0, 8);
  const dir = path.join(dirBase, id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id, nome: nome || nomeArquivo || id, arquivo: nomeArquivo, criado: new Date().toISOString(), canais: {} };
  let bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [c, d] of Object.entries(canais)) {
    if (!d.lon.length) continue;
    fs.writeFileSync(path.join(dir, `${c}.lon`), Buffer.from(d.lon.buffer, d.lon.byteOffset, d.lon.byteLength));
    fs.writeFileSync(path.join(dir, `${c}.lat`), Buffer.from(d.lat.buffer, d.lat.byteOffset, d.lat.byteLength));
    fs.writeFileSync(path.join(dir, `${c}.val`), Buffer.from(d.val.buffer, d.val.byteOffset, d.val.byteLength));
    const bb = limites(d.lon, d.lat);
    bbox = [Math.min(bbox[0], bb[0]), Math.min(bbox[1], bb[1]), Math.max(bbox[2], bb[2]), Math.max(bbox[3], bb[3])];
    meta.canais[c] = { pontos: d.lon.length, coluna: d.coluna || null, bbox: bb, unidade: CANAIS[c].unidade };
  }
  if (!Object.keys(meta.canais).length) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw Object.assign(new Error('Nenhum canal reconhecido (magnetometria, K, eTh, eU ou CT).'), { status: 400 });
  }
  meta.bbox = bbox;
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  return meta;
}

function limites(lon, lat) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < lon.length; i++) {
    if (lon[i] < a) a = lon[i]; if (lon[i] > c) c = lon[i];
    if (lat[i] < b) b = lat[i]; if (lat[i] > d) d = lat[i];
  }
  return [a, b, c, d];
}

function conversor({ zona, sul, epsg, geografico }) {
  if (epsg) {
    const p = interpretarEpsg(epsg);
    if (!p) throw Object.assign(new Error(`EPSG ${epsg} não suportado. Use SIRGAS 2000/WGS84 geográfico ou UTM.`), { status: 400 });
    if (p.geografico) return (x, y) => [x, y];
    return (x, y) => deUtm(x, y, p.zona, p.sul);
  }
  if (geografico) return (x, y) => [x, y];
  if (!zona) return null;
  return (x, y) => deUtm(x, y, Number(zona), sul !== false && sul !== 'false');
}

// XYZ do Geosoft (linhas "/ cabeçalho", "Line", "Tie"), CSV ou texto separado por espaços
async function lerXyz(arq, { zona, sul, epsg }) {
  const rl = readline.createInterface({ input: fs.createReadStream(arq, { encoding: 'latin1' }), crlfDelay: Infinity });
  let cab = null, sep = null, ultimoComentario = null;
  let idx = null, conv = null;
  const saida = {};
  let linhasLidas = 0;
  const dividir = (l) => (sep === 'ws' ? l.trim().split(/\s+/) : l.split(sep).map((s) => s.trim()));
  for await (const bruta of rl) {
    const l = bruta.trim();
    if (!l) continue;
    if (l.startsWith('/') || l.startsWith('#')) { ultimoComentario = l.replace(/^[\/#]+/, '').trim(); continue; }
    if (/^(LINE|TIE|TRAVERSE|FLIGHT)\b/i.test(l)) continue;
    if (!sep) sep = l.includes(';') ? ';' : l.includes(',') ? ',' : l.includes('\t') ? '\t' : 'ws';
    const partes = dividir(l);
    if (!cab) {
      if (partes.some((p) => /[A-Za-z_]/.test(p) && !ehNumero(p))) { cab = partes.map(norm); continue; }
      if (ultimoComentario) {
        const c = ultimoComentario.split(/[\s,;]+/).filter(Boolean).map(norm);
        if (c.length === partes.length) cab = c;
      }
      if (!cab) throw Object.assign(new Error('Cabeçalho não encontrado. A primeira linha deve ter os nomes das colunas (ex.: X Y MAGIGRF KPERC ETH EU).'), { status: 400 });
    }
    if (!idx) {
      const achar = (re) => cab.findIndex((h) => re.test(h));
      idx = { lon: achar(RE_LON), lat: achar(RE_LAT), x: achar(RE_X), y: achar(RE_Y), canais: {} };
      for (const [c, def] of Object.entries(CANAIS)) {
        // respeita a ordem de prioridade do padrão
        const nomes = def.re.source.replace(/^\^\(|\)\$$/g, '').split('|');
        for (const n of nomes) { const i = cab.indexOf(n); if (i >= 0) { idx.canais[c] = i; break; } }
      }
      if (idx.lon >= 0 && idx.lat >= 0) conv = (x, y) => [x, y];
      else if (idx.x >= 0 && idx.y >= 0) {
        conv = conversor({ zona, sul, epsg });
        if (!conv) throw Object.assign(new Error('O arquivo tem apenas X/Y (UTM). Informe a zona UTM e o hemisfério na importação.'), { status: 400 });
      } else throw Object.assign(new Error(`Colunas de coordenadas não encontradas. Cabeçalho: ${cab.join(', ')}`), { status: 400 });
      if (!Object.keys(idx.canais).length) throw Object.assign(new Error(`Nenhuma coluna de magnetometria ou gama reconhecida. Cabeçalho: ${cab.join(', ')}`), { status: 400 });
      for (const c of Object.keys(idx.canais)) saida[c] = { lon: new Vetor(), lat: new Vetor(), val: new Vetor(Float32Array), coluna: cab[idx.canais[c]] };
    }
    const xi = idx.lon >= 0 ? idx.lon : idx.x, yi = idx.lon >= 0 ? idx.lat : idx.y;
    if (!ehNumero(partes[xi]) || !ehNumero(partes[yi])) continue;
    const [lon, lat] = conv(Number(partes[xi]), Number(partes[yi]));
    if (!Number.isFinite(lon) || Math.abs(lat) > 90) continue;
    for (const [c, i] of Object.entries(idx.canais)) {
      const s = partes[i];
      if (!ehNumero(s)) continue;
      const v = Number(s);
      if (v <= -99999 || v >= 1e20 || v === -9999) continue;
      saida[c].lon.push(lon); saida[c].lat.push(lat); saida[c].val.push(v);
    }
    linhasLidas++;
  }
  if (!linhasLidas) throw Object.assign(new Error('Nenhuma linha de dados válida.'), { status: 400 });
  return Object.fromEntries(Object.entries(saida).map(([c, d]) => [c, { lon: d.lon.final(), lat: d.lat.final(), val: d.val.final(), coluna: d.coluna }]));
}

function gradeParaPontos({ nx, ny, x0, yTopo, dx, dy, valores, nodata }, conv, canal) {
  const lon = new Vetor(), lat = new Vetor(), val = new Vetor(Float32Array);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = valores[j * nx + i];
      if (!Number.isFinite(v) || v === nodata || v <= -99999 || v >= 1e20) continue;
      const [lo, la] = conv(x0 + (i + 0.5) * dx, yTopo - (j + 0.5) * dy);
      lon.push(lo); lat.push(la); val.push(v);
    }
  }
  return { [canal]: { lon: lon.final(), lat: lat.final(), val: val.final(), coluna: 'grade' } };
}

async function lerGeoTiff(arq, { canal, zona, sul, epsg }) {
  if (!CANAIS[canal]) throw Object.assign(new Error('Informe qual canal a grade representa (mag, k, th, u ou ct).'), { status: 400 });
  const { fromArrayBuffer } = await import('geotiff');
  const buf = fs.readFileSync(arq);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const img = await tiff.getImage();
  const rx = (await img.readRasters({ interleave: false, samples: [0] }))[0];
  const [ox, oy] = img.getOrigin();
  const [rxRes, ryRes] = img.getResolution();
  const keys = img.getGeoKeys() || {};
  const codigo = epsg || keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey;
  const conv = conversor({ zona, sul, epsg: codigo && codigo !== 32767 ? codigo : undefined, geografico: !codigo && Math.abs(ox) <= 180 });
  if (!conv) throw Object.assign(new Error('Não foi possível identificar a projeção do GeoTIFF. Informe o EPSG ou a zona UTM.'), { status: 400 });
  const nodata = img.getGDALNoData();
  return gradeParaPontos({ nx: img.getWidth(), ny: img.getHeight(), x0: ox, yTopo: oy, dx: rxRes, dy: Math.abs(ryRes), valores: rx, nodata }, conv, canal);
}

function lerAsc(arq, { canal, zona, sul, epsg }) {
  if (!CANAIS[canal]) throw Object.assign(new Error('Informe qual canal a grade representa (mag, k, th, u ou ct).'), { status: 400 });
  const txt = fs.readFileSync(arq, 'latin1').split(/\r?\n/);
  const h = {};
  let i = 0;
  for (; i < 7 && i < txt.length; i++) {
    const m = txt[i].trim().match(/^([A-Za-z_]+)\s+(-?[\d.eE+-]+)$/);
    if (!m) break;
    h[m[1].toLowerCase()] = Number(m[2]);
  }
  const nx = h.ncols, ny = h.nrows, d = h.cellsize;
  const x0 = h.xllcorner ?? (h.xllcenter - d / 2), y0 = h.yllcorner ?? (h.yllcenter - d / 2);
  const valores = new Float32Array(nx * ny);
  let k = 0;
  for (; i < txt.length && k < valores.length; i++) for (const s of txt[i].trim().split(/\s+/)) if (s) valores[k++] = Number(s);
  const conv = conversor({ zona, sul, epsg, geografico: !zona && !epsg && Math.abs(x0) <= 180 });
  if (!conv) throw Object.assign(new Error('Informe a zona UTM (ou EPSG) da grade ASCII.'), { status: 400 });
  return gradeParaPontos({ nx, ny, x0, yTopo: y0 + ny * d, dx: d, dy: d, valores, nodata: h.nodata_value }, conv, canal);
}

export function listarLevantamentos(dirBase) {
  if (!fs.existsSync(dirBase)) return [];
  return fs.readdirSync(dirBase).filter((d) => fs.existsSync(path.join(dirBase, d, 'meta.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(dirBase, d, 'meta.json'), 'utf8')));
}

function carregarCanal(dirBase, id, canal) {
  const dir = path.join(dirBase, id);
  const ler = (ext, T) => { const b = fs.readFileSync(path.join(dir, `${canal}.${ext}`)); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  return { lon: ler('lon', Float64Array), lat: ler('lat', Float64Array), val: ler('val', Float32Array) };
}

// ---------------------------------------------------------------------------
// Interpolação em grade regular (UTM)
// ---------------------------------------------------------------------------
function interpolar(xs, ys, vs, g) {
  const { nx, ny, x0, y0, dx } = g;
  const n = nx * ny;
  const soma = new Float64Array(n), cont = new Uint32Array(n);
  for (let p = 0; p < xs.length; p++) {
    const i = Math.floor((xs[p] - x0) / dx), j = Math.floor((ys[p] - y0) / dx);
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    soma[j * nx + i] += vs[p]; cont[j * nx + i]++;
  }
  const bin = new Float32Array(n).fill(NaN);
  let cheios = 0;
  for (let k = 0; k < n; k++) if (cont[k]) { bin[k] = soma[k] / cont[k]; cheios++; }
  if (!cheios) return null;
  const R = Math.max(2, Math.min(12, Math.ceil(1 / Math.sqrt(cheios / n)) + 1));
  const out = new Float32Array(bin);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!Number.isNaN(bin[j * nx + i])) continue;
      let sw = 0, sv = 0, quad = 0;
      for (let b = -R; b <= R; b++) {
        const jj = j + b; if (jj < 0 || jj >= ny) continue;
        for (let a = -R; a <= R; a++) {
          const ii = i + a; if (ii < 0 || ii >= nx) continue;
          const v = bin[jj * nx + ii];
          if (Number.isNaN(v)) continue;
          const d2 = a * a + b * b; if (d2 > R * R) continue;
          const w = 1 / d2; sw += w; sv += w * v;
          quad |= (a >= 0 ? 1 : 2) * (b >= 0 ? 1 : 4);
        }
      }
      // exige vizinhos em pelo menos 3 quadrantes para não extrapolar além do levantamento
      const nq = [1, 2, 4, 8].filter((q) => quad & q).length;
      if (sw > 0 && nq >= 3) out[j * nx + i] = sv / sw;
    }
  }
  return suavizar(out, nx, ny);
}

function suavizar(g, nx, ny) {
  const out = new Float32Array(g.length).fill(NaN);
  const w = [1, 2, 1];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (Number.isNaN(g[j * nx + i])) continue;
    let s = 0, sw = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const ii = i + a, jj = j + b;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const v = g[jj * nx + ii]; if (Number.isNaN(v)) continue;
      const p = w[a + 1] * w[b + 1]; s += p * v; sw += p;
    }
    out[j * nx + i] = s / sw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// FFT 2D e filtros no domínio do número de onda
// ---------------------------------------------------------------------------
function fft1(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inv ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < h; j++) {
        const a = i + j, b = a + h;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function fft2(re, im, px, py, inv) {
  const tr = new Float64Array(px), ti = new Float64Array(px);
  for (let j = 0; j < py; j++) {
    const o = j * px;
    tr.set(re.subarray(o, o + px)); ti.set(im.subarray(o, o + px));
    fft1(tr, ti, inv);
    re.set(tr, o); im.set(ti, o);
  }
  const cr = new Float64Array(py), ci = new Float64Array(py);
  for (let i = 0; i < px; i++) {
    for (let j = 0; j < py; j++) { cr[j] = re[j * px + i]; ci[j] = im[j * px + i]; }
    fft1(cr, ci, inv);
    for (let j = 0; j < py; j++) { re[j * px + i] = cr[j]; im[j * px + i] = ci[j]; }
  }
}

const pot2 = (n) => 2 ** Math.ceil(Math.log2(n));

// Preenche lacunas (NaN) por expansão das bordas, para permitir a FFT
function preencher(g, nx, ny) {
  const out = new Float64Array(g);
  let faltam = 0;
  for (let k = 0; k < out.length; k++) if (Number.isNaN(out[k])) faltam++;
  for (let passo = 0; faltam && passo < 200; passo++) {
    const prev = new Float64Array(out);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!Number.isNaN(prev[k])) continue;
      let s = 0, c = 0;
      if (i > 0 && !Number.isNaN(prev[k - 1])) { s += prev[k - 1]; c++; }
      if (i < nx - 1 && !Number.isNaN(prev[k + 1])) { s += prev[k + 1]; c++; }
      if (j > 0 && !Number.isNaN(prev[k - nx])) { s += prev[k - nx]; c++; }
      if (j < ny - 1 && !Number.isNaN(prev[k + nx])) { s += prev[k + nx]; c++; }
      if (c) { out[k] = s / c; faltam--; }
    }
  }
  if (faltam) { const m = media(out); for (let k = 0; k < out.length; k++) if (Number.isNaN(out[k])) out[k] = m; }
  return out;
}

function media(a) {
  let s = 0, n = 0;
  for (const v of a) if (Number.isFinite(v)) { s += v; n++; }
  return n ? s / n : 0;
}

// Prepara o espectro: remove média, expande com espelhamento e atenuação cossenoidal
function espectro(cheia, nx, ny) {
  const px = pot2(Math.ceil(nx * 1.3)), py = pot2(Math.ceil(ny * 1.3));
  const ox = Math.floor((px - nx) / 2), oy = Math.floor((py - ny) / 2);
  const m = media(cheia);
  const re = new Float64Array(px * py), im = new Float64Array(px * py);
  const refletir = (k, n) => { let r = k; while (r < 0 || r >= n) r = r < 0 ? -r - 1 : 2 * n - r - 1; return r; };
  for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) {
    const gi = i - ox, gj = j - oy;
    const v = cheia[refletir(gj, ny) * nx + refletir(gi, nx)] - m;
    const fx = gi < 0 ? -gi / ox : gi >= nx ? (gi - nx + 1) / (px - nx - ox) : 0;
    const fy = gj < 0 ? -gj / oy : gj >= ny ? (gj - ny + 1) / (py - ny - oy) : 0;
    const d = Math.min(1, Math.max(fx || 0, fy || 0));
    re[j * px + i] = v * 0.5 * (1 + Math.cos(Math.PI * d));
  }
  fft2(re, im, px, py, false);
  return { re, im, px, py, ox, oy, m };
}

function filtrar(esp, nx, ny, dx, fn, somarMedia = false) {
  const { px, py, ox, oy } = esp;
  const re = new Float64Array(esp.re), im = new Float64Array(esp.im);
  for (let j = 0; j < py; j++) {
    const fj = j <= py / 2 ? j : j - py;
    const ky = 2 * Math.PI * fj / (py * dx);
    for (let i = 0; i < px; i++) {
      const fi = i <= px / 2 ? i : i - px;
      const kx = 2 * Math.PI * fi / (px * dx);
      const f = fn(Math.hypot(kx, ky), kx, ky);
      re[j * px + i] *= f; im[j * px + i] *= f;
    }
  }
  fft2(re, im, px, py, true);
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out[j * nx + i] = re[(j + oy) * px + (i + ox)] + (somarMedia ? esp.m : 0);
  return out;
}

function derivadasXY(g, nx, ny, dx) {
  const gx = new Float32Array(g.length), gy = new Float32Array(g.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    const l = i > 0 ? g[k - 1] : g[k], r = i < nx - 1 ? g[k + 1] : g[k];
    const b = j > 0 ? g[k - nx] : g[k], t = j < ny - 1 ? g[k + nx] : g[k];
    gx[k] = (r - l) / ((i > 0 && i < nx - 1 ? 2 : 1) * dx);
    gy[k] = (t - b) / ((j > 0 && j < ny - 1 ? 2 : 1) * dx);
  }
  return [gx, gy];
}

const mapear = (n, fn) => { const o = new Float32Array(n); for (let k = 0; k < n; k++) o[k] = fn(k); return o; };
const mascarar = (g, mascara) => { for (let k = 0; k < g.length; k++) if (mascara[k]) g[k] = NaN; return g; };

// ---------------------------------------------------------------------------
// Catálogo de produtos
// ---------------------------------------------------------------------------
export const PRODUTOS = [
  { id: 'mag_cma', grupo: 'Magnetometria', nome: 'Campo magnético anômalo (CMA)', unidade: 'nT', nota: 'Dado interpolado. Base para todos os demais produtos magnéticos.' },
  { id: 'mag_cma_sombra', grupo: 'Magnetometria', nome: 'CMA com relevo sombreado', unidade: 'nT', nota: 'Iluminação a NE (45°/45°) realça lineamentos e estruturas.' },
  { id: 'mag_dx', grupo: 'Magnetometria', nome: 'Derivada horizontal X (Dx)', unidade: 'nT/m', nota: 'Realça feições de direção N-S.' },
  { id: 'mag_dy', grupo: 'Magnetometria', nome: 'Derivada horizontal Y (Dy)', unidade: 'nT/m', nota: 'Realça feições de direção E-W.' },
  { id: 'mag_dz', grupo: 'Magnetometria', nome: '1ª derivada vertical (Dz)', unidade: 'nT/m', nota: 'Realça fontes rasas e bordas de corpos.' },
  { id: 'mag_dz2', grupo: 'Magnetometria', nome: '2ª derivada vertical', unidade: 'nT/m²', nota: 'Fontes muito rasas; sensível a ruído.' },
  { id: 'mag_ght', grupo: 'Magnetometria', nome: 'Gradiente horizontal total (GHT)', unidade: 'nT/m', nota: 'Máximos sobre contatos e falhas.' },
  { id: 'mag_asa', grupo: 'Magnetometria', nome: 'Amplitude do sinal analítico (ASA)', unidade: 'nT/m', nota: 'Pouco dependente da direção de magnetização; máximos sobre as fontes. Útil em baixas latitudes.' },
  { id: 'mag_tilt', grupo: 'Magnetometria', nome: 'Inclinação do sinal analítico (Tilt)', unidade: 'graus', nota: 'Valores positivos sobre as fontes; zero próximo aos contatos.' },
  { id: 'mag_tilt_ght', grupo: 'Magnetometria', nome: 'GHT do Tilt (TDX)', unidade: 'rad/m', nota: 'Bordas de fontes com amplitude equalizada.' },
  { id: 'mag_theta', grupo: 'Magnetometria', nome: 'Mapa Theta (cos θ = GHT/ASA)', unidade: '—', nota: 'Detector de bordas normalizado.' },
  { id: 'mag_cont500', grupo: 'Magnetometria', nome: 'Continuação para cima 500 m', unidade: 'nT', nota: 'Atenua fontes rasas; mostra o arcabouço intermediário.' },
  { id: 'mag_cont1000', grupo: 'Magnetometria', nome: 'Continuação para cima 1000 m', unidade: 'nT', nota: 'Componente regional/profunda.' },
  { id: 'mag_cont2000', grupo: 'Magnetometria', nome: 'Continuação para cima 2000 m', unidade: 'nT', nota: 'Fontes profundas.' },
  { id: 'mag_residual', grupo: 'Magnetometria', nome: 'Residual (CMA − cont. 1000 m)', unidade: 'nT', nota: 'Separação regional-residual: realça anomalias locais.' },
  { id: 'gama_k', grupo: 'Gamaespectrometria', nome: 'Potássio (K)', unidade: '%', nota: 'Alterações potássicas, granitos, metassedimentos.' },
  { id: 'gama_th', grupo: 'Gamaespectrometria', nome: 'Tório equivalente (eTh)', unidade: 'ppm', nota: 'Elemento pouco móvel; bom marcador litológico.' },
  { id: 'gama_u', grupo: 'Gamaespectrometria', nome: 'Urânio equivalente (eU)', unidade: 'ppm', nota: '' },
  { id: 'gama_ct', grupo: 'Gamaespectrometria', nome: 'Contagem total (CT)', unidade: 'µR/h', nota: '' },
  { id: 'gama_th_k', grupo: 'Gamaespectrometria', nome: 'Razão eTh/K', unidade: '—', nota: 'Valores baixos podem indicar enriquecimento em K (alteração hidrotermal).' },
  { id: 'gama_u_k', grupo: 'Gamaespectrometria', nome: 'Razão eU/K', unidade: '—', nota: '' },
  { id: 'gama_u_th', grupo: 'Gamaespectrometria', nome: 'Razão eU/eTh', unidade: '—', nota: 'Mobilidade de urânio.' },
  { id: 'gama_ternario', grupo: 'Gamaespectrometria', nome: 'Composição ternária RGB (K-eTh-eU)', unidade: '—', nota: 'Vermelho = K, verde = eTh, azul = eU.' },
  { id: 'gama_ternario_cmy', grupo: 'Gamaespectrometria', nome: 'Composição ternária CMY', unidade: '—', nota: 'Ciano = K, magenta = eTh, amarelo = eU.' },
  { id: 'gama_f', grupo: 'Gamaespectrometria', nome: 'Fator F (K·eU/eTh)', unidade: '—', nota: 'Indicador clássico de alteração potássica.' },
  { id: 'gama_kd', grupo: 'Gamaespectrometria', nome: 'Potássio anômalo (Kd)', unidade: '—', nota: 'Desvio de K em relação ao esperado pelo eTh (normalização de Saunders).' },
  { id: 'gama_ud', grupo: 'Gamaespectrometria', nome: 'Urânio anômalo (Ud)', unidade: '—', nota: 'Desvio de eU em relação ao esperado pelo eTh.' },
];

// ---------------------------------------------------------------------------
// Processamento de uma área
// ---------------------------------------------------------------------------
export async function processarArea(dirBase, levId, area, dirSaida, opcoes = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(dirBase, levId, 'meta.json'), 'utf8'));
  const bufferKm = Number(opcoes.bufferKm ?? 2);
  const areaF = area.type === 'Feature' ? area : turf.feature(area);
  const regiao = bufferKm > 0 ? turf.buffer(areaF, bufferKm, { units: 'kilometers' }) : areaF;
  const bb = turf.bbox(regiao);
  const [clon, clat] = turf.centroid(areaF).geometry.coordinates;
  const zona = zonaDe(clon), sul = clat < 0;

  // Extensão UTM da região
  const cantos = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [(bb[0] + bb[2]) / 2, bb[1]], [(bb[0] + bb[2]) / 2, bb[3]]].map(([x, y]) => paraUtm(x, y, zona, sul));
  const ux0 = Math.min(...cantos.map((c) => c[0])), ux1 = Math.max(...cantos.map((c) => c[0]));
  const uy0 = Math.min(...cantos.map((c) => c[1])), uy1 = Math.max(...cantos.map((c) => c[1]));
  const margem = 0.05 * Math.max(bb[2] - bb[0], bb[3] - bb[1]);

  // Carrega pontos dentro da região
  const dados = {};
  for (const c of Object.keys(meta.canais)) {
    const { lon, lat, val } = carregarCanal(dirBase, levId, c);
    const xs = new Vetor(), ys = new Vetor(), vs = new Vetor(Float32Array);
    for (let p = 0; p < lon.length; p++) {
      if (lon[p] < bb[0] - margem || lon[p] > bb[2] + margem || lat[p] < bb[1] - margem || lat[p] > bb[3] + margem) continue;
      const [x, y] = paraUtm(lon[p], lat[p], zona, sul);
      xs.push(x); ys.push(y); vs.push(val[p]);
    }
    if (xs.n >= 20) dados[c] = { x: xs.final(), y: ys.final(), v: vs.final() };
  }
  if (!Object.keys(dados).length) {
    throw Object.assign(new Error('O levantamento não cobre a área escolhida (menos de 20 pontos na região).'), { status: 400 });
  }

  // Tamanho de célula
  const areaM2 = (ux1 - ux0) * (uy1 - uy0);
  // Dados de linha: espaçamento entre linhas L ≈ A / (N · d), onde d é o passo ao longo da linha.
  // Célula padrão = L/4 (prática usual em aerolevantamentos), nunca menor que d.
  const estimar = (d) => {
    const passos = [];
    for (let p = 1; p < d.x.length && passos.length < 20000; p++) {
      const s = Math.hypot(d.x[p] - d.x[p - 1], d.y[p] - d.y[p - 1]);
      if (s > 0) passos.push(s);
    }
    passos.sort((a, b) => a - b);
    const passo = passos[Math.floor(passos.length / 2)] || Math.sqrt(areaM2 / d.x.length);
    const linhas = areaM2 / (d.x.length * passo);
    return Math.max(linhas / 4, passo);
  };
  let celula = Number(opcoes.celula) || Math.min(...Object.values(dados).map(estimar));
  celula = Math.max(10, Math.min(2000, celula));
  const maxLado = Number(opcoes.maxLado) || 512;
  celula = Math.max(celula, (ux1 - ux0) / maxLado, (uy1 - uy0) / maxLado);
  celula = Math.round(celula);
  const nx = Math.max(8, Math.ceil((ux1 - ux0) / celula)), ny = Math.max(8, Math.ceil((uy1 - uy0) / celula));
  const g = { nx, ny, x0: ux0, y0: uy0, dx: celula, zona, sul };

  const grades = {};
  for (const [c, d] of Object.entries(dados)) {
    const r = interpolar(d.x, d.y, d.v, g);
    if (r) grades[c] = r;
  }
  const n = nx * ny;
  const resultado = {};

  if (grades.mag) {
    const cma = grades.mag;
    const mascara = mapear(n, (k) => (Number.isNaN(cma[k]) ? 1 : 0));
    const cheia = preencher(cma, nx, ny);
    const esp = espectro(cheia, nx, ny);
    const dz = filtrar(esp, nx, ny, celula, (k) => k);
    const dz2 = filtrar(esp, nx, ny, celula, (k) => k * k);
    const up = (h) => filtrar(esp, nx, ny, celula, (k) => Math.exp(-k * h), true);
    const [gx, gy] = derivadasXY(Float32Array.from(cheia), nx, ny, celula);
    const ght = mapear(n, (k) => Math.hypot(gx[k], gy[k]));
    const asa = mapear(n, (k) => Math.hypot(gx[k], gy[k], dz[k]));
    const tilt = mapear(n, (k) => Math.atan2(dz[k], ght[k]));
    const [tx, ty] = derivadasXY(tilt, nx, ny, celula);
    const c1000 = up(1000);
    Object.assign(resultado, {
      mag_cma: cma, mag_cma_sombra: cma,
      mag_dx: gx, mag_dy: gy, mag_dz: dz, mag_dz2: dz2, mag_ght: ght, mag_asa: asa,
      mag_tilt: mapear(n, (k) => (tilt[k] * 180) / Math.PI),
      mag_tilt_ght: mapear(n, (k) => Math.hypot(tx[k], ty[k])),
      mag_theta: mapear(n, (k) => (asa[k] > 0 ? ght[k] / asa[k] : NaN)),
      mag_cont500: up(500), mag_cont1000: c1000, mag_cont2000: up(2000),
      mag_residual: mapear(n, (k) => cma[k] - c1000[k]),
    });
    for (const [id, gr] of Object.entries(resultado)) if (id.startsWith('mag_') && id !== 'mag_cma' && id !== 'mag_cma_sombra') mascarar(gr, mascara);
  }

  const { k: K, th: TH, u: U, ct: CT } = grades;
  if (K) resultado.gama_k = K;
  if (TH) resultado.gama_th = TH;
  if (U) resultado.gama_u = U;
  if (CT) resultado.gama_ct = CT;
  const pos = (v, piso) => (Number.isFinite(v) ? Math.max(v, piso) : NaN);
  if (K && TH) resultado.gama_th_k = mapear(n, (k) => pos(TH[k], 0.1) / pos(K[k], 0.05));
  if (K && U) resultado.gama_u_k = mapear(n, (k) => pos(U[k], 0.05) / pos(K[k], 0.05));
  if (U && TH) resultado.gama_u_th = mapear(n, (k) => pos(U[k], 0.05) / pos(TH[k], 0.1));
  if (K && TH && U) {
    resultado.gama_ternario = K; resultado.gama_ternario_cmy = K;
    resultado.gama_f = mapear(n, (k) => (pos(K[k], 0.05) * pos(U[k], 0.05)) / pos(TH[k], 0.1));
  }
  if (K && TH) {
    const rel = media(K) / media(TH);
    resultado.gama_kd = mapear(n, (k) => { const ks = rel * pos(TH[k], 0.1); return (K[k] - ks) / ks; });
  }
  if (U && TH) {
    const rel = media(U) / media(TH);
    resultado.gama_ud = mapear(n, (k) => { const us = rel * pos(TH[k], 0.1); return (U[k] - us) / us; });
  }

  // Raster de exibição em coordenadas geográficas
  fs.mkdirSync(path.join(dirSaida, 'produtos'), { recursive: true });
  fs.mkdirSync(path.join(dirSaida, 'grades'), { recursive: true });
  const cantosGeo = [[ux0, uy0], [ux0 + nx * celula, uy0], [ux0, uy0 + ny * celula], [ux0 + nx * celula, uy0 + ny * celula]].map(([x, y]) => deUtm(x, y, zona, sul));
  const geoBox = [Math.min(...cantosGeo.map((c) => c[0])), Math.min(...cantosGeo.map((c) => c[1])), Math.max(...cantosGeo.map((c) => c[0])), Math.max(...cantosGeo.map((c) => c[1]))];
  const W = nx, H = Math.round(nx * (geoBox[3] - geoBox[1]) / (geoBox[2] - geoBox[0]));
  const amostra = amostrador(g, W, H, geoBox);

  const produtos = [];
  const dentro = mascaraArea(g, areaF);
  for (const def of PRODUTOS) {
    const gr = resultado[def.id];
    if (!gr) continue;
    let rgba, legenda;
    if (def.id === 'gama_ternario' || def.id === 'gama_ternario_cmy') {
      rgba = renderTernario([K, TH, U], amostra, W, H, def.id === 'gama_ternario_cmy');
      legenda = { tipo: 'ternario', cmy: def.id === 'gama_ternario_cmy' };
    } else {
      const r = renderEqualizado(gr, amostra, W, H, def.id === 'mag_cma_sombra' ? sombreamento(preencher(gr, nx, ny), nx, ny, celula) : null);
      rgba = r.rgba; legenda = r.legenda;
    }
    const png = new PNG({ width: W, height: H });
    png.data = Buffer.from(rgba.buffer);
    fs.writeFileSync(path.join(dirSaida, 'produtos', `${def.id}.png`), PNG.sync.write(png));
    // world file (.pgw) em graus e .prj
    const px = (geoBox[2] - geoBox[0]) / W, py = (geoBox[3] - geoBox[1]) / H;
    fs.writeFileSync(path.join(dirSaida, 'produtos', `${def.id}.pgw`), [px, 0, 0, -py, geoBox[0] + px / 2, geoBox[3] - py / 2].join('\n'));
    fs.writeFileSync(path.join(dirSaida, 'produtos', `${def.id}.prj`), WKT_GEO);
    if (!def.id.startsWith('gama_ternario') && def.id !== 'mag_cma_sombra') {
      escreverAsc(path.join(dirSaida, 'grades', `${def.id}.asc`), gr, g);
      fs.writeFileSync(path.join(dirSaida, 'grades', `${def.id}.prj`), wktUtm(zona, sul));
    }
    produtos.push({ ...def, legenda, estatisticas: estatisticas(gr, dentro) });
  }

  const resumo = {
    levantamento: { id: meta.id, nome: meta.nome },
    grade: { celula, nx, ny, zona, sul, epsg: (sul ? 31960 : 31954) + zona, x0: ux0, y0: uy0 },
    limites: geoBox,
    pontos: Object.fromEntries(Object.entries(dados).map(([c, d]) => [c, d.x.length])),
    produtos,
    anomalias: anomalias(resultado, dentro, g),
  };
  fs.writeFileSync(path.join(dirSaida, 'geofisica.json'), JSON.stringify(resumo));
  return resumo;
}

function escreverAsc(arq, gr, g) {
  const linhas = [`ncols ${g.nx}`, `nrows ${g.ny}`, `xllcorner ${g.x0}`, `yllcorner ${g.y0}`, `cellsize ${g.dx}`, 'NODATA_value -99999'];
  for (let j = g.ny - 1; j >= 0; j--) {
    const l = [];
    for (let i = 0; i < g.nx; i++) { const v = gr[j * g.nx + i]; l.push(Number.isFinite(v) ? +v.toPrecision(7) : -99999); }
    linhas.push(l.join(' '));
  }
  fs.writeFileSync(arq, linhas.join('\n'));
}

// Para cada pixel do raster geográfico, índice fracionário na grade UTM
function amostrador(g, W, H, box) {
  const fi = new Float32Array(W * H), fj = new Float32Array(W * H);
  for (let pj = 0; pj < H; pj++) for (let pi = 0; pi < W; pi++) {
    const lon = box[0] + (pi + 0.5) * (box[2] - box[0]) / W;
    const lat = box[3] - (pj + 0.5) * (box[3] - box[1]) / H;
    const [x, y] = paraUtm(lon, lat, g.zona, g.sul);
    fi[pj * W + pi] = (x - g.x0) / g.dx - 0.5;
    fj[pj * W + pi] = (y - g.y0) / g.dx - 0.5;
  }
  return { fi, fj, nx: g.nx, ny: g.ny };
}

function bilinear(gr, a, p) {
  const x = a.fi[p], y = a.fj[p];
  const i = Math.floor(x), j = Math.floor(y);
  if (i < 0 || j < 0 || i >= a.nx - 1 || j >= a.ny - 1) {
    const ii = Math.round(x), jj = Math.round(y);
    return ii >= 0 && jj >= 0 && ii < a.nx && jj < a.ny ? gr[jj * a.nx + ii] : NaN;
  }
  const tx = x - i, ty = y - j, nx = a.nx;
  const v00 = gr[j * nx + i], v10 = gr[j * nx + i + 1], v01 = gr[(j + 1) * nx + i], v11 = gr[(j + 1) * nx + i + 1];
  if ([v00, v10, v01, v11].some(Number.isNaN)) return gr[Math.round(y) * nx + Math.round(x)];
  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
}

const PALETA = [[0, [20, 20, 140]], [0.15, [30, 90, 255]], [0.3, [0, 200, 255]], [0.45, [0, 200, 90]], [0.6, [200, 225, 0]], [0.72, [255, 210, 0]], [0.85, [255, 100, 0]], [0.95, [225, 0, 0]], [1, [255, 90, 200]]];
export function cor(t) {
  for (let s = 1; s < PALETA.length; s++) {
    if (t <= PALETA[s][0]) {
      const [t0, c0] = PALETA[s - 1], [t1, c1] = PALETA[s];
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, i) => Math.round(v + (c1[i] - v) * f));
    }
  }
  return PALETA.at(-1)[1];
}
export const PALETA_CSS = `linear-gradient(to right, ${PALETA.map(([t, c]) => `rgb(${c.join(',')}) ${t * 100}%`).join(', ')})`;

function quantis(gr) {
  const v = Float32Array.from(gr.filter(Number.isFinite)).sort();
  return (q) => (v.length ? v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))] : 0);
}

// Equalização de histograma (padrão em mapas geofísicos)
function renderEqualizado(gr, a, W, H, sombra) {
  const q = quantis(gr);
  const niveis = Array.from({ length: 257 }, (_, i) => q(i / 256));
  const rgba = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const v = bilinear(gr, a, p);
    if (!Number.isFinite(v)) continue;
    let lo = 0, hi = 256;
    while (lo < hi) { const m = (lo + hi) >> 1; if (niveis[m] < v) lo = m + 1; else hi = m; }
    let c = cor(lo / 256);
    if (sombra) { const s = bilinear(sombra, a, p); c = c.map((x) => Math.round(x * (0.35 + 0.65 * s))); }
    rgba.set([c[0], c[1], c[2], 255], p * 4);
  }
  return { rgba, legenda: { tipo: 'equalizado', p2: q(0.02), p25: q(0.25), p50: q(0.5), p75: q(0.75), p98: q(0.98), min: q(0), max: q(1) } };
}

function renderTernario([K, TH, U], a, W, H, cmy) {
  const esc = [K, TH, U].map((g) => { const q = quantis(g); return [q(0.02), q(0.98)]; });
  const rgba = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const c = [K, TH, U].map((g, i) => {
      const v = bilinear(g, a, p);
      return Number.isFinite(v) ? Math.round(255 * Math.min(1, Math.max(0, (v - esc[i][0]) / (esc[i][1] - esc[i][0] || 1)))) : NaN;
    });
    if (c.some(Number.isNaN)) continue;
    rgba.set([...(cmy ? c.map((x) => 255 - x) : c), 255], p * 4);
  }
  return rgba;
}

function sombreamento(g, nx, ny, dx) {
  const [gx, gy] = derivadasXY(Float32Array.from(g), nx, ny, dx);
  const q = quantis(mapear(nx * ny, (k) => Math.hypot(gx[k], gy[k])));
  const esc = 1 / (q(0.95) || 1);
  const az = (45 * Math.PI) / 180, alt = (45 * Math.PI) / 180;
  return mapear(nx * ny, (k) => {
    const sx = gx[k] * esc, sy = gy[k] * esc;
    const n = Math.hypot(sx, sy, 1);
    const v = (-sx * Math.sin(az) * Math.cos(alt) - sy * Math.cos(az) * Math.cos(alt) + Math.sin(alt)) / n;
    return Math.max(0, Math.min(1, v));
  });
}

function mascaraArea(g, areaF) {
  const m = new Uint8Array(g.nx * g.ny);
  const bb = turf.bbox(areaF);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const [lon, lat] = deUtm(g.x0 + (i + 0.5) * g.dx, g.y0 + (j + 0.5) * g.dx, g.zona, g.sul);
    if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    if (turf.booleanPointInPolygon([lon, lat], areaF)) m[j * g.nx + i] = 1;
  }
  return m;
}

function estatisticas(gr, dentro) {
  let n = 0, s = 0, s2 = 0, mn = Infinity, mx = -Infinity;
  for (let k = 0; k < gr.length; k++) {
    if (!dentro[k] || !Number.isFinite(gr[k])) continue;
    const v = gr[k]; n++; s += v; s2 += v * v; if (v < mn) mn = v; if (v > mx) mx = v;
  }
  if (!n) return { celulas_na_area: 0 };
  const m = s / n;
  return { celulas_na_area: n, media: +m.toPrecision(5), desvio: +Math.sqrt(Math.max(0, s2 / n - m * m)).toPrecision(5), min: +mn.toPrecision(5), max: +mx.toPrecision(5) };
}

// Anomalias: células da área acima de média + 2σ do produto na região inteira
function anomalias(res, dentro, g) {
  const alvos = [
    ['mag_asa', 'Amplitude do sinal analítico alta (fonte magnética)'],
    ['mag_residual', 'Anomalia magnética residual positiva'],
    ['gama_f', 'Fator F alto (possível alteração potássica)'],
    ['gama_kd', 'Potássio anômalo (Kd) positivo'],
    ['gama_u_th', 'Razão eU/eTh alta'],
  ];
  const out = [];
  for (const [id, descricao] of alvos) {
    const gr = res[id]; if (!gr) continue;
    let n = 0, s = 0, s2 = 0;
    for (const v of gr) if (Number.isFinite(v)) { n++; s += v; s2 += v * v; }
    if (!n) continue;
    const m = s / n, dp = Math.sqrt(Math.max(0, s2 / n - m * m)), lim = m + 2 * dp;
    let na = 0, acima = 0, melhor = -Infinity, kMelhor = -1;
    for (let k = 0; k < gr.length; k++) {
      if (!dentro[k] || !Number.isFinite(gr[k])) continue;
      na++;
      if (gr[k] > lim) acima++;
      if (gr[k] > melhor) { melhor = gr[k]; kMelhor = k; }
    }
    if (!na) continue;
    const i = kMelhor % g.nx, j = Math.floor(kMelhor / g.nx);
    const [lon, lat] = deUtm(g.x0 + (i + 0.5) * g.dx, g.y0 + (j + 0.5) * g.dx, g.zona, g.sul);
    out.push({ produto: id, descricao, limiar: +lim.toPrecision(4), perc_area: Math.round((acima / na) * 1000) / 10, maximo: +melhor.toPrecision(4), ponto_maximo: [+lon.toFixed(6), +lat.toFixed(6)] });
  }
  return out;
}

// KMZ com os produtos como GroundOverlay
export function montarKmz(dirSaida, resumo, areaGeo, titulo) {
  const zip = new AdmZip();
  const [w, s, e, n] = resumo.limites;
  const xml = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const overlays = resumo.produtos.map((p, i) => {
    zip.addFile(`produtos/${p.id}.png`, fs.readFileSync(path.join(dirSaida, 'produtos', `${p.id}.png`)));
    return `<GroundOverlay><name>${xml(p.nome)}</name><visibility>${i === 0 ? 1 : 0}</visibility><color>d0ffffff</color><Icon><href>produtos/${p.id}.png</href></Icon><LatLonBox><north>${n}</north><south>${s}</south><east>${e}</east><west>${w}</west></LatLonBox></GroundOverlay>`;
  });
  const anel = (r) => r.map((c) => `${c[0]},${c[1]},0`).join(' ');
  const g = areaGeo.type === 'Feature' ? areaGeo.geometry : areaGeo;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const area = `<Placemark><name>Área analisada</name><Style><LineStyle><color>ff00ffff</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style><MultiGeometry>${polys.map((p) => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${anel(p[0])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`).join('')}</MultiGeometry></Placemark>`;
  zip.addFile('doc.kml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(titulo)}</name>${area}<Folder><name>Produtos geofísicos</name>${overlays.join('')}</Folder></Document></kml>`));
  return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// Levantamento sintético (FICTÍCIO) para demonstração
// ---------------------------------------------------------------------------
export function gerarXyzExemplo(centro = [-44.2, -20.4], { ladoKm = 40, linhaM = 500, passoM = 60 } = {}) {
  const zona = zonaDe(centro[0]), sul = centro[1] < 0;
  const [cx, cy] = paraUtm(centro[0], centro[1], zona, sul);
  let semente = 7;
  const rnd = () => ((semente = (semente * 16807) % 2147483647) / 2147483647);
  const fontes = Array.from({ length: 9 }, () => ({ x: cx + (rnd() - 0.5) * ladoKm * 900, y: cy + (rnd() - 0.5) * ladoKm * 900, amp: (rnd() - 0.3) * 600, r: 800 + rnd() * 2500 }));
  const granitos = Array.from({ length: 3 }, () => ({ x: cx + (rnd() - 0.5) * ladoKm * 800, y: cy + (rnd() - 0.5) * ladoKm * 800, r: 3000 + rnd() * 5000 }));
  const alvo = { x: cx + 3000, y: cy - 2000, r: 1200 };
  const linhas = ['/ LEVANTAMENTO FICTÍCIO GERADO PELO FILÃO (não é dado real)', '/ X Y LONGITUDE LATITUDE MAGIGRF KPERC ETH EU CTCOR'];
  const meio = (ladoKm * 1000) / 2;
  let num = 1000;
  for (let y = cy - meio; y <= cy + meio; y += linhaM) {
    linhas.push(`Line ${num++}`);
    for (let x = cx - meio; x <= cx + meio; x += passoM) {
      let mag = 0.004 * (x - cx) + 0.002 * (y - cy);
      for (const f of fontes) {
        const dx = x - f.x, dy = y - f.y, d2 = (dx * dx + dy * dy) / (f.r * f.r);
        mag += f.amp * Math.exp(-d2) - 0.45 * f.amp * Math.exp(-((dx * dx + (dy - f.r * 0.8) ** 2) / (f.r * f.r)));
      }
      let k = 0.8, th = 6, u = 1.2;
      for (const g of granitos) { const w = Math.exp(-((x - g.x) ** 2 + (y - g.y) ** 2) / (g.r * g.r)); k += 2.2 * w; th += 14 * w; u += 2.5 * w; }
      const wa = Math.exp(-((x - alvo.x) ** 2 + (y - alvo.y) ** 2) / (alvo.r * alvo.r));
      k += 2.5 * wa; u += 1.2 * wa; mag += 250 * wa;
      k = Math.max(0.05, k + (rnd() - 0.5) * 0.25); th = Math.max(0.5, th + (rnd() - 0.5) * 2); u = Math.max(0.1, u + (rnd() - 0.5) * 0.8);
      mag += (rnd() - 0.5) * 2;
      const [lon, lat] = deUtm(x, y, zona, sul);
      linhas.push([x.toFixed(1), y.toFixed(1), lon.toFixed(6), lat.toFixed(6), mag.toFixed(2), k.toFixed(3), th.toFixed(2), u.toFixed(2), (k * 2 + th * 0.4 + u).toFixed(2)].join(' '));
    }
  }
  return linhas.join('\n');
}
