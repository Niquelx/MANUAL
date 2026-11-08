// Filtros prontos (classificação dos processos a partir dos dados do SIGMINE/ANM).
// As regras usam expressões regulares sobre FASE e ÚLTIMO EVENTO, sem acentos e em maiúsculas.
// São heurísticas transparentes: o texto exato dos eventos da ANM pode variar.
// Você pode criar filtros próprios com o mesmo formato na aba Filtros.

export const GRUPOS_CATEGORIAS = ['Áreas em disponibilidade', 'Status', 'Pesquisas'];

const CONCLUIDO = '(ARREMAT|VENCEDOR|ADJUDIC|HOMOLOG)';
const ENCERRADO = '(ARREMAT|VENCEDOR|ADJUDIC|HOMOLOG|FRACASS|DESERT)';

export const CATEGORIAS = [
  // Áreas em disponibilidade (procedimento de disponibilidade da ANM: oferta pública e leilão)
  { id: 'aguardando_oferta', grupo: 'Áreas em disponibilidade', nome: 'Aguardando Oferta Pública',
    regra: { qualquer: [{ fase: 'APTO PARA DISPONIBILIDADE' }, { fase: 'DISPONIBILIDADE', evento: 'APT[OA] (PARA|A) (OFERTA|DISPONIBILIDADE)|AGUARD.*OFERTA' }] } },
  { id: 'oferta_publica', grupo: 'Áreas em disponibilidade', nome: 'Oferta Pública',
    regra: { evento: 'OFERTA PUBLICA', eventoNao: `${ENCERRADO}|APT[OA] (PARA|A)` } },
  { id: 'arrematada_oferta', grupo: 'Áreas em disponibilidade', nome: 'Arrematada em Oferta Pública',
    regra: { evento: `OFERTA PUBLICA.*${CONCLUIDO}|${CONCLUIDO}.*OFERTA PUBLICA` } },
  { id: 'em_leilao', grupo: 'Áreas em disponibilidade', nome: 'Em Leilão',
    regra: { evento: 'LEILAO', eventoNao: ENCERRADO } },
  { id: 'arrematada_leilao', grupo: 'Áreas em disponibilidade', nome: 'Arrematada em Leilão',
    regra: { evento: `LEILAO.*${CONCLUIDO}|${CONCLUIDO}.*LEILAO` } },
  { id: 'livre_fracassada', grupo: 'Áreas em disponibilidade', nome: 'Área Livre (Fracassadas)',
    regra: { evento: '(OFERTA|LEILAO|DISPONIBILIDADE).*(FRACASS|DESERT|SEM (INTERESSADO|PROPOSTA))|(FRACASS|DESERT).*(OFERTA|LEILAO|DISPONIBILIDADE)' } },
  { id: 'retirada', grupo: 'Áreas em disponibilidade', nome: 'Área Retirada (Retificação)',
    regra: { fase: 'DISPONIBILIDADE', evento: 'RETIRAD|RETIFIC|EXCLUI?DA' } },

  // Status simplificado (agrupa as fases oficiais)
  { id: 'pedido_pesquisa', grupo: 'Status', nome: 'Pedido de Pesquisa em análise',
    regra: { fase: '^REQUERIMENTO DE PESQUISA$' } },
  { id: 'pesquisa_autorizada', grupo: 'Status', nome: 'Pesquisa Mineral Autorizada',
    regra: { fase: '^AUTORIZACAO DE PESQUISA$' } },
  { id: 'pedido_lavra', grupo: 'Status', nome: 'Pedido de Lavra em análise',
    regra: { fase: '^(REQUERIMENTO DE (LAVRA|LAVRA GARIMPEIRA|LICENCIAMENTO|REGISTRO DE EXTRACAO)|DIREITO DE REQUERER A LAVRA)$' } },
  { id: 'lavra_autorizada', grupo: 'Status', nome: 'Lavra Autorizada',
    regra: { fase: '^(CONCESSAO DE LAVRA|LICENCIAMENTO|LAVRA GARIMPEIRA|REGISTRO DE EXTRACAO)$' } },
  { id: 'bloqueio', grupo: 'Status', nome: 'Bloqueio Administrativo',
    regra: { evento: 'BLOQUEI|SOBREST' },
    nota: 'Por texto do último evento. Para o polígono oficial das áreas bloqueadas, ligue a camada "Áreas de bloqueio (ANM)".' },
  { id: 'area_livre', grupo: 'Status', nome: 'Área Livre',
    regra: { especial: 'livre' },
    nota: 'Processos que saíram da base ativa da ANM entre duas importações e cuja área não é tocada por nenhum processo ativo. Indício de área livre: confirme na ANM.' },
  { id: 'disp_nao_julgada', grupo: 'Status', nome: 'Disponibilidade não julgada',
    regra: { fase: 'DISPONIBILIDADE', eventoNao: 'OFERTA|LEILAO|ARREMAT|FRACASS|DESERT|RETIR|RETIFIC|JULGAD|APT[OA] (PARA|A)' } },

  // Pesquisas prontas
  { id: 'registro_recente', grupo: 'Pesquisas', nome: 'Pedido de Registro Recente',
    regra: { especial: 'recente' },
    nota: 'Processos que apareceram na base nos últimos N dias (configurável) ou requerimentos do ano corrente.' },
  { id: 'titulo_publicado', grupo: 'Pesquisas', nome: 'Título minerário publicado',
    regra: { evento: '(ALVARA|PORTARIA|TITULO|LICENCA|PERMISSAO|REGISTRO|CONCESSAO).*PUBLICAD', diasEvento: 90 },
    nota: 'Último evento de publicação de título nos últimos 90 dias.' },
  { id: 'renovacao', grupo: 'Pesquisas', nome: 'Renovação Título Minerário',
    regra: { evento: 'PRORROG|RENOVA' } },
  { id: 'vencimento', grupo: 'Pesquisas', nome: 'Título Próximo ao Vencimento',
    regra: { especial: 'vencimento' },
    nota: 'ESTIMATIVA: data de publicação do alvará (último evento ou histórico) + prazo configurado. O SIGMINE não traz a data de vencimento; confira no Cadastro Mineiro.' },

  // Usada pela camada "Minas Ativas - CFEM"
  { id: 'minas_cfem', grupo: null, nome: 'Minas ativas (CFEM)', regra: { especial: 'cfem' } },
];

export const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// Compila uma regra em função (feature, contexto) => boolean
export function compilarRegra(regra = {}) {
  if (regra.qualquer) {
    const fs = regra.qualquer.map(compilarRegra);
    return (f, ctx) => fs.some((fn) => fn(f, ctx));
  }
  const re = (s) => (s ? new RegExp(s, 'i') : null);
  const fase = re(regra.fase), faseNao = re(regra.faseNao), ev = re(regra.evento), evNao = re(regra.eventoNao);
  const subs = re(regra.substancia), tit = re(regra.titular);
  const dias = Number(regra.diasEvento) || 0;
  return (f, ctx) => {
    const p = f.properties;
    const F = semAcento(p.fase), E = semAcento(p.ult_evento);
    if (fase && !fase.test(F)) return false;
    if (faseNao && faseNao.test(F)) return false;
    if (ev && !ev.test(E)) return false;
    if (evNao && evNao.test(E)) return false;
    if (subs && !subs.test(semAcento(p.substancia))) return false;
    if (tit && !tit.test(semAcento(p.titular))) return false;
    if (dias) {
      if (!p.data_evento) return false;
      if ((ctx.agora - Date.parse(p.data_evento)) / 864e5 > dias) return false;
    }
    if (regra.especial === 'livre') return !!p.livre;
    if (regra.especial === 'recente') {
      if (p.visto_em && (ctx.agora - Date.parse(p.visto_em)) / 864e5 <= ctx.config.diasRecente) return true;
      return /^REQUERIMENTO/.test(F) && p.ano === new Date(ctx.agora).getFullYear();
    }
    if (regra.especial === 'vencimento') {
      const v = ctx.vencimento(f);
      if (!v) return false;
      const d = (Date.parse(v) - ctx.agora) / 864e5;
      return d >= -30 && d <= ctx.config.diasAvisoVencimento;
    }
    if (regra.especial === 'cfem') return !!ctx.cfemAtiva(p);
    return true;
  };
}

// Valida regex digitadas pelo usuário
export function validarRegra(regra) {
  for (const k of ['fase', 'faseNao', 'evento', 'eventoNao', 'substancia', 'titular']) {
    if (regra[k]) {
      const erro = (msg) => Object.assign(new Error(msg), { status: 400 });
      if (String(regra[k]).length > 300) throw erro(`Expressão "${k}" longa demais.`);
      try { new RegExp(regra[k], 'i'); } catch (e) { throw erro(`Expressão inválida em "${k}": ${e.message}`); }
    }
  }
  return regra;
}
