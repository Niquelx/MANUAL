// Gera uma base FICTÍCIA para testar o sistema sem internet.
// Os processos, titulares e números abaixo são inventados.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Base } from '../lib/base.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = new Base(process.env.DADOS || path.join(RAIZ, 'data'));

let semente = 42;
const rnd = () => ((semente = (semente * 16807) % 2147483647) / 2147483647);
const pega = (a) => a[Math.floor(rnd() * a.length)];

const FASES = ['REQUERIMENTO DE PESQUISA', 'AUTORIZAÇÃO DE PESQUISA', 'REQUERIMENTO DE LAVRA', 'CONCESSÃO DE LAVRA', 'LICENCIAMENTO', 'REQUERIMENTO DE LICENCIAMENTO', 'DISPONIBILIDADE', 'LAVRA GARIMPEIRA'];
const SUBS = ['MINÉRIO DE FERRO', 'OURO', 'AREIA', 'GRANITO', 'CALCÁRIO', 'QUARTZITO', 'MANGANÊS', 'BAUXITA', 'ARGILA', 'FOSFATO', 'LÍTIO', 'NÍQUEL'];
const USOS = ['INDUSTRIAL', 'CONSTRUÇÃO CIVIL', 'FERTILIZANTES', 'JOALHERIA', 'NÃO INFORMADO'];
const TIT = ['EXEMPLO MINERAÇÃO LTDA', 'PEDRA FICTÍCIA S.A.', 'TESTE RECURSOS MINERAIS LTDA', 'JOÃO DE EXEMPLO', 'MINERADORA MODELO EIRELI', 'COOPERATIVA DEMONSTRAÇÃO', 'AREAL IMAGINÁRIO LTDA'];
const EVT = ['ALVARÁ DE PESQUISA PUBLICADO', 'RELATÓRIO FINAL DE PESQUISA APRESENTADO', 'TAXA ANUAL POR HECTARE PAGA', 'EXIGÊNCIA PUBLICADA', 'CUMPRIMENTO DE EXIGÊNCIA PROTOCOLIZADO', 'REQUERIMENTO DE LAVRA PROTOCOLIZADO', 'PORTARIA DE LAVRA PUBLICADA'];
const ZONAS = { MG: [-44.2, -20.4], GO: [-49.3, -16.6], PA: [-50.1, -6.1] };

const feats = [];
let n = 1;
for (const [uf, [lon0, lat0]] of Object.entries(ZONAS)) {
  for (let i = 0; i < 400; i++) {
    const lon = lon0 + (rnd() - 0.5) * 1.2, lat = lat0 + (rnd() - 0.5) * 1.2;
    const w = 0.005 + rnd() * 0.04, h = 0.005 + rnd() * 0.04;
    const ano = 1990 + Math.floor(rnd() * 35);
    const num = String(800000 + n++).padStart(6, '0');
    const d = `${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}/${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}/${2015 + Math.floor(rnd() * 10)}`;
    feats.push({
      type: 'Feature',
      properties: {
        PROCESSO: `${num.slice(0, 3)}.${num.slice(3)}/${ano}`, NUMERO: num, ANO: ano,
        FASE: pega(FASES), ULT_EVENTO: `${pega(EVT)} EM ${d}`, NOME: pega(TIT),
        SUBS: pega(SUBS), USO: pega(USOS), UF: uf,
      },
      geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + w, lat], [lon + w, lat + h], [lon, lat + h], [lon, lat]]] },
    });
  }
}
console.log(base.importarProcessos(feats, { origem: 'exemplo fictício' }));

// Camada fictícia de "área protegida" para demonstrar camadas temáticas
base.estado.camadas.filter((c) => c.grupo === 'Exemplo').forEach((c) => base.removerCamada(c.id));
base.salvarCamada({
  nome: 'Área protegida (fictícia)', cor: '#2f9e44', grupo: 'Exemplo',
  features: [{ type: 'Feature', properties: { nome: 'Parque Exemplo' }, geometry: { type: 'Polygon', coordinates: [[[-44.3, -20.5], [-44.0, -20.5], [-44.0, -20.25], [-44.3, -20.25], [-44.3, -20.5]]] } }],
});
console.log('Base de exemplo criada. Rode: npm start');
