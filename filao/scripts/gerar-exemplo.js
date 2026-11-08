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
const EVT = ['ALVARÁ DE PESQUISA PUBLICADO', 'RELATÓRIO FINAL DE PESQUISA APRESENTADO', 'TAXA ANUAL POR HECTARE PAGA', 'EXIGÊNCIA PUBLICADA', 'CUMPRIMENTO DE EXIGÊNCIA PROTOCOLIZADO', 'REQUERIMENTO DE LAVRA PROTOCOLIZADO', 'PORTARIA DE LAVRA PUBLICADA', 'PRORROGAÇÃO DE PRAZO DO ALVARÁ DE PESQUISA PUBLICADA', 'BLOQUEIO PROVISÓRIO DA ÁREA'];
const EVT_DISP = ['ÁREA APTA PARA OFERTA PÚBLICA', 'ÁREA EM OFERTA PÚBLICA - EDITAL PUBLICADO', 'OFERTA PÚBLICA - ÁREA ARREMATADA', 'ÁREA INCLUÍDA EM LEILÃO ELETRÔNICO', 'LEILÃO - VENCEDOR HOMOLOGADO', 'OFERTA PÚBLICA FRACASSADA', 'ÁREA RETIRADA DA DISPONIBILIDADE POR RETIFICAÇÃO', 'DISPONIBILIDADE - AGUARDANDO DECISÃO'];
const hoje = new Date();
const dataRecente = () => { const d = new Date(hoje - Math.floor(rnd() * 1300) * 864e5); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
const ZONAS = { MG: [-44.2, -20.4], GO: [-49.3, -16.6], PA: [-50.1, -6.1] };

const feats = [];
let n = 1;
for (const [uf, [lon0, lat0]] of Object.entries(ZONAS)) {
  for (let i = 0; i < 400; i++) {
    const lon = lon0 + (rnd() - 0.5) * 1.2, lat = lat0 + (rnd() - 0.5) * 1.2;
    const w = 0.005 + rnd() * 0.04, h = 0.005 + rnd() * 0.04;
    const ano = 1990 + Math.floor(rnd() * 35);
    const num = String(800000 + n++).padStart(6, '0');
    const d = dataRecente();
    const fase = pega(FASES);
    const evento = fase === 'DISPONIBILIDADE' ? pega(EVT_DISP) : fase === 'AUTORIZAÇÃO DE PESQUISA' && rnd() < 0.5 ? 'ALVARÁ DE PESQUISA PUBLICADO' : pega(EVT);
    feats.push({
      type: 'Feature',
      properties: {
        PROCESSO: `${num.slice(0, 3)}.${num.slice(3)}/${ano}`, NUMERO: num, ANO: ano,
        FASE: fase, ULT_EVENTO: `${evento} EM ${d}`, NOME: pega(TIT),
        SUBS: pega(SUBS), USO: pega(USOS), UF: uf,
      },
      geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + w, lat], [lon + w, lat + h], [lon, lat + h], [lon, lat]]] },
    });
  }
}
console.log(base.importarProcessos(feats, { origem: 'exemplo fictício (carga 1)' }));

// Segunda carga: alguns processos "saem" da base (simula extinção) e outros mudam de fase,
// para alimentar histórico, filtro "Área Livre" e alertas.
const segunda = feats.filter(() => rnd() > 0.03).map((f) => (rnd() < 0.05
  ? { ...f, properties: { ...f.properties, FASE: 'REQUERIMENTO DE LAVRA', ULT_EVENTO: `REQUERIMENTO DE LAVRA PROTOCOLIZADO EM ${dataRecente()}` } }
  : f));
const ano = hoje.getFullYear();
for (let i = 0; i < 15; i++) {
  const lon = -44.2 + (rnd() - 0.5), lat = -20.4 + (rnd() - 0.5);
  const num = String(870000 + i).padStart(6, '0');
  segunda.push({ type: 'Feature', properties: { PROCESSO: `${num.slice(0, 3)}.${num.slice(3)}/${ano}`, FASE: 'REQUERIMENTO DE PESQUISA', ULT_EVENTO: `REQUERIMENTO DE PESQUISA PROTOCOLIZADO EM ${dataRecente()}`, NOME: pega(TIT), SUBS: pega(SUBS), USO: pega(USOS), UF: 'MG' }, geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.02, lat], [lon + 0.02, lat + 0.02], [lon, lat + 0.02], [lon, lat]]] } });
}
console.log(base.importarProcessos(segunda, { origem: 'exemplo fictício (carga 2)' }));

// CFEM fictícia: 60 processos com recolhimento recente
const linhas = ['Ano;Mês;Processo;AnoDoProcesso;Tipo_PF_PJ;CPF_CNPJ;Substância;UF;Município;QuantidadeComercializada;UnidadeDeMedida;ValorRecolhido'];
for (const f of segunda.slice(0, 60)) {
  const [n, a] = f.properties.PROCESSO.replace('.', '').split('/');
  linhas.push(`${ano};${1 + Math.floor(rnd() * 9)};${n};${a};PJ;00.000.000/0001-00;${f.properties.SUBS};${f.properties.UF};MUNICÍPIO EXEMPLO;1000;t;${(rnd() * 50000).toFixed(2).replace('.', ',')}`);
}
const { lerCfem } = await import('../lib/cfem.js');
console.log(base.importarCfem(lerCfem(Buffer.from(linhas.join('\n'))).mapa, 'exemplo fictício'));

// Camada fictícia de "área protegida" para demonstrar camadas temáticas
base.estado.camadas.filter((c) => c.grupo === 'Exemplo').forEach((c) => base.removerCamada(c.id));
base.salvarCamada({
  nome: 'Área protegida (fictícia)', cor: '#2f9e44', grupo: 'Exemplo',
  features: [{ type: 'Feature', properties: { nome: 'Parque Exemplo' }, geometry: { type: 'Polygon', coordinates: [[[-44.3, -20.5], [-44.0, -20.5], [-44.0, -20.25], [-44.3, -20.25], [-44.3, -20.5]]] } }],
});
console.log('Base de exemplo criada. Rode: npm start');

// Levantamento aerogeofísico FICTÍCIO sobre a área de exemplo de MG (para a GeoAnálise)
{
  const fs = await import('node:fs');
  const { gerarXyzExemplo, importarLevantamento, listarLevantamentos } = await import('../lib/geofisica.js');
  const dirGeof = path.join(process.env.DADOS || path.join(RAIZ, 'data'), 'geofisica');
  for (const l of listarLevantamentos(dirGeof)) if (/FICTÍCIO/.test(l.nome)) fs.rmSync(path.join(dirGeof, l.id), { recursive: true, force: true });
  const tmp = path.join(dirGeof, '..', 'exemplo-tmp.xyz');
  fs.mkdirSync(dirGeof, { recursive: true });
  fs.writeFileSync(tmp, gerarXyzExemplo([-44.2, -20.4], { ladoKm: 60 }));
  const meta = await importarLevantamento(dirGeof, tmp, { nome: 'Levantamento FICTÍCIO de demonstração (MG)', nomeArquivo: 'exemplo.xyz' });
  fs.rmSync(tmp, { force: true });
  console.log('Levantamento fictício:', Object.entries(meta.canais).map(([c, x]) => `${c} ${x.pontos}`).join(', '));
}
