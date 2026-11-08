// Uso:
//   npm run importar -- MG SP          (baixa a base oficial da ANM por UF)
//   npm run importar -- arquivo.zip     (importa um shapefile/GeoJSON/KML local)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Base } from '../lib/base.js';
import { lerArquivoGeo } from '../lib/importador.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = new Base(process.env.DADOS || path.join(RAIZ, 'data'));
const args = process.argv.slice(2);
if (!args.length) {
  console.log('Informe UFs (ex.: MG SP) ou caminhos de arquivos (.zip, .geojson, .kml).');
  process.exit(1);
}
for (const a of args) {
  try {
    let resumo;
    if (/^[A-Za-z]{2}$/.test(a)) {
      const url = base.estado.config.urlAnm.replace('{UF}', a.toUpperCase());
      console.log(`Baixando ${url} ...`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const feats = await lerArquivoGeo(Buffer.from(await r.arrayBuffer()), `${a}.zip`);
      resumo = base.importarProcessos(feats, { ufPadrao: a.toUpperCase(), origem: `ANM ${a.toUpperCase()}` });
    } else {
      const feats = await lerArquivoGeo(fs.readFileSync(a), a);
      resumo = base.importarProcessos(feats, { origem: path.basename(a) });
    }
    console.log(`${a}: ${resumo.total} processos (${resumo.novos} novos, ${resumo.alterados} alterados, ${resumo.alertas} alertas)`);
  } catch (e) {
    console.error(`${a}: erro - ${e.message}`);
    process.exitCode = 1;
  }
}
