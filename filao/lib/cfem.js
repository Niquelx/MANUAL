// Leitura da planilha de arrecadação da CFEM (dados abertos da ANM).
// Os nomes de colunas são detectados por aproximação, porque variam entre versões do arquivo.
import { semAcento } from './categorias.js';

export function decodificar(buf) {
  const utf = buf.toString('utf8');
  return utf.includes('�') ? buf.toString('latin1') : utf.replace(/^﻿/, '');
}

function dividir(linha, sep) {
  const out = [];
  let cur = '', aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i];
    if (ch === '"') { if (aspas && linha[i + 1] === '"') { cur += '"'; i++; } else aspas = !aspas; }
    else if (ch === sep && !aspas) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const num = (s) => {
  const t = String(s || '').trim();
  if (!t) return 0;
  const n = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  return Number(n) || 0;
};

// Retorna Map "numero/ano" -> { ultimo: 'AAAA-MM', valor, substancia, municipio, uf }
export function lerCfem(buf, anterior = new Map()) {
  const linhas = decodificar(buf).split(/\r?\n/).filter((l) => l.trim());
  if (linhas.length < 2) throw new Error('Planilha vazia.');
  const sep = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ';' : ',';
  const cab = dividir(linhas[0], sep).map((h) => semAcento(h).replace(/[^A-Z]/g, ''));
  const col = (...res) => cab.findIndex((h) => res.some((r) => r.test(h)));
  const iProc = col(/^PROCESSO$/, /NUMERODOPROCESSO/, /^NUMEROPROCESSO$/);
  const iAnoProc = col(/ANODOPROCESSO/, /ANOPROCESSO/);
  const iAno = col(/^ANO$/, /ANOREFERENCIA/, /ANODEREFERENCIA/, /^ANOARRECADACAO/);
  const iMes = col(/^MES$/, /MESREFERENCIA/, /MESDEREFERENCIA/);
  const iValor = col(/VALORRECOLHIDO/, /^VALOR/, /CFEM/);
  const iSubs = col(/SUBSTANCIA/);
  const iMun = col(/MUNICIPIO/);
  const iUf = col(/^UF$/, /ESTADO/);
  if (iProc < 0) throw new Error(`Coluna de processo não encontrada. Cabeçalho lido: ${linhas[0].slice(0, 200)}`);

  const mapa = new Map(anterior);
  let validas = 0;
  for (const l of linhas.slice(1)) {
    const c = dividir(l, sep);
    const bruto = c[iProc] || '';
    const m = bruto.match(/(\d{3})\.?(\d{3})\s*\/\s*(\d{4})/);
    let numero, ano;
    if (m) { numero = m[1] + m[2]; ano = m[3]; }
    else {
      numero = bruto.replace(/\D/g, '').padStart(6, '0').slice(-6);
      ano = (c[iAnoProc] || '').replace(/\D/g, '');
    }
    if (!numero || !ano) continue;
    const anoRef = Number(c[iAno]) || 0;
    const mesRef = Number(c[iMes]) || 1;
    const ref = anoRef ? `${anoRef}-${String(mesRef).padStart(2, '0')}` : '';
    const chave = `${numero}/${ano}`;
    const atual = mapa.get(chave) || { ultimo: '', valor: 0, substancia: '', municipio: '', uf: '' };
    atual.valor += iValor >= 0 ? num(c[iValor]) : 0;
    if (ref >= atual.ultimo) {
      atual.ultimo = ref;
      if (iSubs >= 0) atual.substancia = c[iSubs];
      if (iMun >= 0) atual.municipio = c[iMun];
      if (iUf >= 0) atual.uf = c[iUf];
    }
    mapa.set(chave, atual);
    validas++;
  }
  if (!validas) throw new Error('Nenhuma linha com número de processo válido.');
  return { mapa, linhas: validas };
}
