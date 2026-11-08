// Acesso a serviços OGC WMS e ArcGIS REST: resolução automática de camadas,
// consulta de atributos (clique no mapa) e legenda.
import { semAcento } from './categorias.js';

const TEMPO = 25000;

async function buscar(url, tipo = 'text') {
  const r = await fetch(url, { signal: AbortSignal.timeout(TEMPO), headers: { 'User-Agent': 'Filao/1.0 (uso pessoal)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${new URL(url).host}`);
  return tipo === 'json' ? r.json() : r.text();
}

const juntar = (url, params) => url + (url.includes('?') ? '&' : '?') + new URLSearchParams(params);

function descreverErro(e) {
  const causa = e.cause?.code || e.cause?.message || '';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(causa + e.message)) {
    return `Certificado TLS não reconhecido pelo Node (${causa}). Rode com NODE_EXTRA_CA_CERTS apontando para a cadeia ICP-Brasil ou use Node 23+ com --use-system-ca.`;
  }
  if (e.name === 'TimeoutError') return 'O servidor não respondeu a tempo.';
  return `${e.message}${causa ? ` (${causa})` : ''}`;
}

// Lê os nomes de camadas de um GetCapabilities WMS
export function nomesWms(xml) {
  const nomes = [];
  const re = /<Layer\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<Name>([^<]+)<\/Name>(?:[\s\S]*?<Title>([^<]*)<\/Title>)?/g;
  let m;
  while ((m = re.exec(xml))) nomes.push({ nome: m[1].trim(), titulo: (m[2] || '').trim() });
  return nomes;
}

export async function resolver(c) {
  const agora = new Date().toISOString();
  try {
    if (c.tipo === 'wms') {
      const xml = await buscar(juntar(c.url, { service: 'WMS', request: 'GetCapabilities', version: '1.3.0' }));
      if (!/WMS_Capabilities|WMT_MS_Capabilities/.test(xml)) throw new Error('Resposta não é um GetCapabilities WMS.');
      const todas = nomesWms(xml);
      const existe = (n) => todas.some((x) => x.nome === n || x.nome.split(':').pop() === n.split(':').pop());
      if (c.camada && !c.multiplas && existe(c.camada)) {
        const real = todas.find((x) => x.nome === c.camada) || todas.find((x) => x.nome.split(':').pop() === c.camada.split(':').pop());
        return { status: 'ok', url: c.url, camada: real.nome, verificado_em: agora };
      }
      const re = c.busca ? new RegExp(c.busca, 'i') : null;
      const evitar = c.evitar ? new RegExp(c.evitar, 'i') : null;
      const cand = todas.filter((x) => re && (re.test(semAcento(x.nome)) || re.test(semAcento(x.titulo))) && !(evitar && evitar.test(semAcento(x.nome + ' ' + x.titulo))));
      if (!cand.length) {
        return { status: 'nao_encontrada', url: c.url, camada: c.camada, verificado_em: agora,
          mensagem: `Camada não localizada. Exemplos disponíveis: ${todas.slice(0, 15).map((x) => x.nome).join(', ')}` };
      }
      const camada = c.multiplas ? cand.map((x) => x.nome).join(',') : cand[0].nome;
      return { status: 'ok', url: c.url, camada, verificado_em: agora, mensagem: c.camada && !c.multiplas ? `Nome atualizado automaticamente (configurado: ${c.camada}).` : '' };
    }

    if (c.tipo === 'arcgis') {
      let url = c.url;
      let info;
      try {
        info = await buscar(juntar(url, { f: 'json' }), 'json');
        if (info.error) throw new Error(info.error.message || 'erro ArcGIS');
      } catch (e) {
        if (!c.pasta || !c.buscaServico) throw e;
        const pasta = await buscar(juntar(c.pasta, { f: 'json' }), 'json');
        const re = new RegExp(c.buscaServico, 'i');
        const serv = (pasta.services || []).find((s) => s.type === 'MapServer' && re.test(semAcento(s.name)));
        if (!serv) throw new Error(`Serviço não encontrado em ${c.pasta}. ${e.message}`);
        const raiz = c.pasta.slice(0, c.pasta.indexOf('/rest/services') + '/rest/services'.length);
        url = `${raiz}/${serv.name.split('/').map(encodeURIComponent).join('/')}/MapServer`;
        info = await buscar(juntar(url, { f: 'json' }), 'json');
      }
      const subs = (info.layers || []).map((l) => ({ id: l.id, nome: l.name, sub: l.subLayerIds }));
      let camadas = c.camadas || [];
      if (c.buscaSubcamada) {
        const re = new RegExp(c.buscaSubcamada, 'i');
        camadas = subs.filter((l) => !l.sub && re.test(l.nome)).map((l) => l.id);
        if (!camadas.length) {
          return { status: 'nao_encontrada', url, camadas, verificado_em: agora,
            mensagem: `Nenhuma subcamada com escala correspondente. Subcamadas: ${subs.map((l) => l.nome).slice(0, 30).join('; ')}` };
        }
      }
      return { status: 'ok', url, camadas, subcamadas: subs.filter((l) => !camadas.length || camadas.includes(l.id)).map((l) => l.nome), verificado_em: agora };
    }
    return { status: 'ok', verificado_em: agora };
  } catch (e) {
    return { status: 'erro', url: c.url, camada: c.camada, camadas: c.camadas, verificado_em: agora, mensagem: descreverErro(e) };
  }
}

// Consulta atributos no ponto clicado
export async function consultar(c, r, { lat, lng, bbox, largura, altura, x, y }) {
  if (c.tipo === 'arcgis') {
    const params = {
      f: 'json', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', sr: '4326',
      layers: r.camadas?.length ? `visible:${r.camadas.join(',')}` : 'visible', tolerance: '5',
      mapExtent: bbox, imageDisplay: `${largura},${altura},96`, returnGeometry: 'false',
    };
    const j = await buscar(juntar(`${r.url}/identify`, params), 'json');
    if (j.error) throw new Error(j.error.message);
    return (j.results || []).slice(0, 15).map((x) => ({ camada: x.layerName, atributos: x.attributes }));
  }
  if (c.tipo === 'wms') {
    const camadas = r.camada;
    const base = {
      service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo', layers: camadas, query_layers: camadas,
      styles: '', srs: 'EPSG:4326', bbox, width: largura, height: altura, x: Math.round(x), y: Math.round(y), feature_count: '10',
    };
    try {
      const j = await buscar(juntar(r.url, { ...base, info_format: 'application/json' }), 'json');
      return (j.features || []).map((f) => ({ camada: String(f.id || '').split('.')[0] || c.nome, atributos: f.properties }));
    } catch {
      const t = await buscar(juntar(r.url, { ...base, info_format: 'text/plain' }));
      return /no features|^\s*$/i.test(t) ? [] : [{ camada: c.nome, texto: t.slice(0, 4000) }];
    }
  }
  return [];
}

// Legenda: imagens (base64) para ArcGIS; URL GetLegendGraphic para WMS
export async function legenda(c, r) {
  if (c.tipo === 'arcgis') {
    const j = await buscar(juntar(`${r.url}/legend`, { f: 'json' }), 'json');
    return (j.layers || [])
      .filter((l) => !r.camadas?.length || r.camadas.includes(l.layerId))
      .flatMap((l) => (l.legend || []).slice(0, 40).map((it) => ({
        rotulo: it.label || l.layerName, imagem: `data:${it.contentType || 'image/png'};base64,${it.imageData}`,
      })));
  }
  if (c.tipo === 'wms') {
    return String(r.camada || '').split(',').slice(0, 3).map((n) => ({
      rotulo: '', imagem: juntar(r.url, { service: 'WMS', version: '1.1.1', request: 'GetLegendGraphic', format: 'image/png', layer: n }),
    }));
  }
  return [];
}
