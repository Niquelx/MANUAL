// Projeção UTM (Transversa de Mercator) no elipsoide GRS80/SIRGAS 2000.
// A diferença para WGS84 é submilimétrica e irrelevante para este uso.
const a = 6378137;
const f = 1 / 298.257222101;
const k0 = 0.9996;
const e2 = f * (2 - f);
const ep2 = e2 / (1 - e2);
const rad = Math.PI / 180;

export const zonaDe = (lon) => Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1));
const meridiano = (zona) => (zona - 1) * 6 - 180 + 3;

function arcoMeridiano(phi) {
  return a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
}

// lon/lat (graus) -> [E, N] em metros. sul=true usa falso norte de 10.000 km.
export function paraUtm(lon, lat, zona, sul) {
  const phi = lat * rad;
  const lam = (lon - meridiano(zona)) * rad;
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * s * s);
  const T = t * t, C = ep2 * c * c, A = c * lam;
  const M = arcoMeridiano(phi);
  const E = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let Nn = k0 * (M + N * t * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (sul) Nn += 10000000;
  return [E, Nn];
}

// [E, N] -> [lon, lat]
export function deUtm(E, Nn, zona, sul) {
  const x = E - 500000;
  const y = sul ? Nn - 10000000 : Nn;
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * s * s);
  const T1 = t * t, C1 = ep2 * c * c;
  const R1 = a * (1 - e2) / (1 - e2 * s * s) ** 1.5;
  const D = x / (N1 * k0);
  const lat = phi1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [meridiano(zona) + lon / rad, lat / rad];
}

// Código EPSG SIRGAS 2000 / UTM (zonas 17–25; sul 31977–31985, norte 31971–31976)
export function epsgSirgas(zona, sul) {
  if (sul && zona >= 17 && zona <= 25) return 31960 + zona;
  if (!sul && zona >= 17 && zona <= 22) return 31954 + zona;
  return (sul ? 32700 : 32600) + zona; // WGS84 UTM como alternativa
}

// Interpreta EPSG de GeoTIFF/arquivo -> { geografico } ou { zona, sul }
export function interpretarEpsg(codigo) {
  const c = Number(codigo);
  if ([4326, 4674, 4618, 4989].includes(c)) return { geografico: true };
  if (c >= 31977 && c <= 31985) return { zona: c - 31960, sul: true };
  if (c >= 31971 && c <= 31976) return { zona: c - 31954, sul: false };
  if (c >= 32701 && c <= 32760) return { zona: c - 32700, sul: true };
  if (c >= 32601 && c <= 32660) return { zona: c - 32600, sul: false };
  if (c >= 29177 && c <= 29185) return { zona: c - 29160, sul: true }; // SAD69 UTM S (aproximação)
  return null;
}

export function wktUtm(zona, sul) {
  const cm = meridiano(zona);
  return `PROJCS["SIRGAS 2000 / UTM zone ${zona}${sul ? 'S' : 'N'}",GEOGCS["SIRGAS 2000",DATUM["Sistema_de_Referencia_Geocentrico_para_las_AmericaS_2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",${cm}],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",${sul ? 10000000 : 0}],UNIT["metre",1]]`;
}

export const WKT_GEO = 'GEOGCS["SIRGAS 2000",DATUM["Sistema_de_Referencia_Geocentrico_para_las_AmericaS_2000",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
