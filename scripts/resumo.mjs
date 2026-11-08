// Monta o resumo do dia do grupo assim que o dia fecha (meia-noite, horário de Brasília) e manda no WhatsApp
// pelo CallMeBot. Roda logo depois do coletar.mjs, em toda execução do workflow: se o resumo de ontem ainda
// não existe (a execução da meia-noite falhou, o site ficou fora do ar...), ele é feito na próxima.
// O XP vem do Wise Old Man pelo intervalo exato do dia, então o resumo sai igual em qualquer horário.
// O resumo também fica no data.json para o site mostrar com o botão "Enviar no WhatsApp".
// Uso: node scripts/resumo.mjs <data.json>
// Variáveis: CALLMEBOT_PHONE e CALLMEBOT_APIKEY (segredos do GitHub); FORCAR_RESUMO=true refaz e manda na hora (teste).

import { readFile, writeFile } from 'node:fs/promises';

const FILE = process.argv[2] || 'data.json';
const SITE = 'https://mymax1337.github.io/xp-grupo-gim/';
const API = 'https://api.wiseoldman.net/v2';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'xp-grupo-gim (github.com/Mymax1337/xp-grupo-gim)' };
const TZ = 'America/Sao_Paulo';
const OFFSET = '-03:00';   // Brasília não tem horário de verão desde 2019
const FORCE = process.env.FORCAR_RESUMO === 'true';
const SHORT = { 'GIM Serasa': 'Serasa', 'GIM Skol': 'Skol', 'GIM Zezinho': 'Zezinho', 'GIM Elite Br': 'Elite Br' };
const SKILL_NAMES = { runecrafting: 'Runecraft' };
const SKILLING_BOSSES = new Set(['wintertodt', 'tempoross', 'zalcano']);   // contam como skill, não PvM

const nf = new Intl.NumberFormat('pt-BR');
const d1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const plus = n => (n > 0 ? '+' : '') + nf.format(n);
const hrs = h => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${d1.format(h)} h`);
const skillName = k => SKILL_NAMES[k] || k[0].toUpperCase() + k.slice(1);
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Data e hora em Brasília, qualquer que seja o fuso do servidor.
function local(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map(x => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { iso: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), label: `${WD[wd]} ${p.day}/${p.month}` };
}

// O mesmo ritmo do coletor (~19 pedidos por minuto) e a mesma espera quando o WOM pede calma.
let lastRequest = Date.now();
async function api(path) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + 3200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(API + path, { headers: HEADERS });
    if (res.status === 429 && attempt < 4) { await sleep(30000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }
}

function stats(p, gd, from, to) {
  if (!gd) return null;
  const sk = gd.skills || {};
  const bosses = Object.values(gd.bosses || {}).filter(b => b.kills.gained > 0);
  const comp = gd.computed || {};
  return {
    name: SHORT[p.name] || p.name,
    xp: sk.overall ? sk.overall.experience.gained : 0,
    levels: sk.overall ? sk.overall.level.gained : 0,
    ups: Object.values(sk).filter(s => s.metric !== 'overall' && s.level.gained > 0)
      .sort((a, b) => b.experience.gained - a.experience.gained),
    kc: bosses.reduce((a, b) => a + b.kills.gained, 0),
    pvmKills: bosses.filter(b => !SKILLING_BOSSES.has(b.metric)).reduce((a, b) => a + b.kills.gained, 0),
    ehb: comp.ehb ? comp.ehb.value.gained : 0,
    ehp: comp.ehp ? comp.ehp.value.gained : 0,
    achievements: (p.achievements || []).filter(a => { const t = Date.parse(a.createdAt); return t >= from && t < to; }),
  };
}

// Vencedores (empates entram todos), como no painel Destaques do site.
function winners(list, key, dir) {
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; if (Math.abs(d) > 1e-6) return d; } return 0; };
  const sorted = list.slice().sort((a, b) => dir * cmp(key(a), key(b)));
  return sorted.filter(v => cmp(key(v), key(sorted[0])) === 0);
}
const names = list => list.map(v => v.name).join(' e ');

function buildText(list, dayLabel) {
  if (!list.length) return null;
  const ranked = list.slice().sort((a, b) => b.xp - a.xp);
  const medal = ['🥇', '🥈', '🥉', '🐢'];
  const out = [];
  out.push(`🏆 *Resumo do grupo GIM* · ${dayLabel}`, '');
  out.push('*XP do dia*');
  ranked.forEach((v, i) => out.push(`${medal[i] || `${i + 1}º`} ${v.name}: ${plus(v.xp)}`));
  const totalXp = list.reduce((a, v) => a + v.xp, 0);
  const totalLv = list.reduce((a, v) => a + v.levels, 0);
  const totalKc = list.reduce((a, v) => a + v.kc, 0);
  out.push('', `📈 Grupo: ${plus(totalXp)} XP · ${plus(totalLv)} níveis · ${nf.format(totalKc)} chefes`);

  const pvm = winners(list, v => [v.ehb, v.pvmKills], -1);
  const pvmTop = pvm[0];
  out.push(pvmTop.ehb > 1e-6 || pvmTop.pvmKills > 0
    ? `⚔️ Melhor no PvM: ${names(pvm)} (${pvmTop.ehb > 1e-6 ? `${hrs(pvmTop.ehb)} EHB` : ''}${pvmTop.ehb > 1e-6 && pvmTop.pvmKills ? ' · ' : ''}${pvmTop.pvmKills ? `${nf.format(pvmTop.pvmKills)} abates` : ''})`
    : '⚔️ Melhor no PvM: ninguém fez PvM');
  const eff = winners(list, v => [v.ehp], -1);
  out.push(eff[0].ehp > 1e-6 ? `⏱️ Mais eficiente: ${names(eff)} (${hrs(eff[0].ehp)} EHP)` : '⏱️ Mais eficiente: ninguém ganhou horas eficientes');
  const worst = winners(list, v => [v.xp], 1);
  out.push(worst.length === list.length
    ? `🐢 Lanterninha: empate, todos com ${plus(worst[0].xp)} XP`
    : `🐢 Lanterninha: ${names(worst)} (${plus(worst[0].xp)} XP)`);

  const ups = ranked.filter(v => v.ups.length);
  if (ups.length) {
    out.push('', '*Subiram de nível*');
    for (const v of ups) {
      const shown = v.ups.slice(0, 4).map(s => `${skillName(s.metric)} ${s.level.end}`);
      out.push(`• ${v.name}: ${shown.join(', ')}${v.ups.length > 4 ? ` e mais ${v.ups.length - 4}` : ''}`);
    }
  }
  const ach = ranked.filter(v => v.achievements.length);
  if (ach.length) {
    out.push('', '*Conquistas*');
    for (const v of ach) out.push(`• ${v.name}: ${v.achievements.slice(0, 4).map(a => a.name).join(', ')}`);
  }
  out.push('', `🔗 ${SITE}`);
  return out.join('\n');
}

async function sendWhatsApp(text) {
  const phone = process.env.CALLMEBOT_PHONE;
  const key = process.env.CALLMEBOT_APIKEY;
  if (!phone || !key) { console.log('CallMeBot não configurado: resumo gerado, mas não enviado.'); return false; }
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    const body = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const ok = r.ok && /queued|sent|enviad/i.test(body);
    console.log(`CallMeBot respondeu ${r.status}: ${body.slice(0, 160)}`);   // a resposta não traz o número nem a chave
    return ok;
  } catch (e) {
    console.log(`Falha ao chamar o CallMeBot: ${e.message}`);
    return false;
  }
}

// O último resumo publicado fica no data.json do site. Se não der para ler, o resumo é refeito
// (sai igual, o intervalo é fixo), mas não é mandado de novo no WhatsApp para não repetir.
async function publishedResumo() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${SITE}data.json?t=${Date.now()}`);
      if (r.status === 404) return { ok: true, resumo: null };   // site ainda sem dados
      if (r.ok) return { ok: true, resumo: (await r.json()).resumo || null };
    } catch { /* tenta de novo */ }
    await sleep(5000);
  }
  return { ok: false, resumo: null };
}

const data = JSON.parse(await readFile(FILE, 'utf8'));
const published = await publishedResumo();
let resumo = published.resumo;

const now = new Date();
const today = local(now);
const yesterday = local(new Date(Date.parse(`${today.iso}T12:00:00${OFFSET}`) - 864e5));
const from = Date.parse(`${yesterday.iso}T00:00:00${OFFSET}`);
// Até 0h30 de hoje: pega a leitura da meia-noite (0h05), que fecha o dia.
const to = Math.min(now.getTime(), Date.parse(`${today.iso}T00:30:00${OFFSET}`));

if (FORCE || !resumo || resumo.de !== yesterday.iso) {
  const list = [];
  let missing = 0;
  for (const p of data.players || []) {
    try {
      const g = await api(`/players/${encodeURIComponent(p.name)}/gained?startDate=${new Date(from).toISOString()}&endDate=${new Date(to).toISOString()}`);
      list.push(stats(p, g.data, from, to));
    } catch (e) {
      console.log(`Sem o XP de ontem de ${p.name}: ${e.message}`);
      // Logo depois da meia-noite as últimas 24 horas são o próprio dia; mais tarde, melhor tentar na próxima hora.
      const day = p.periods && p.periods.day && p.periods.day.gained;
      if (today.hour <= 2 && day) list.push(stats(p, day.data, from, to)); else missing++;
    }
  }
  const text = !missing ? buildText(list.filter(Boolean), yesterday.label) : null;
  if (text) {
    console.log(`--- resumo de ${yesterday.iso} ---\n${text}\n--------------`);
    const sent = published.ok || FORCE ? await sendWhatsApp(text) : false;
    resumo = { de: yesterday.iso, rotulo: yesterday.label, geradoEm: now.toISOString(), texto: text, enviado: sent };
  } else {
    console.log('Resumo de ontem incompleto; tento de novo na próxima execução.');
  }
} else {
  console.log(`Resumo de ${resumo.rotulo} já publicado; o de hoje sai à meia-noite.`);
}

if (resumo) data.resumo = resumo;
await writeFile(FILE, JSON.stringify(data));
