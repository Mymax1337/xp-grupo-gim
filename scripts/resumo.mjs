// Monta o resumo do dia do grupo e, à meia-noite (horário de Brasília), manda no WhatsApp pelo CallMeBot.
// Roda logo depois do coletar.mjs, no mesmo workflow. O resumo também fica no data.json para o site
// mostrar com o botão "Enviar no WhatsApp".
// Uso: node scripts/resumo.mjs <data.json>
// Variáveis: CALLMEBOT_PHONE e CALLMEBOT_APIKEY (segredos do GitHub); FORCAR_RESUMO=true manda na hora (teste).

import { readFile, writeFile } from 'node:fs/promises';

const FILE = process.argv[2] || 'data.json';
const SITE = 'https://mymax1337.github.io/xp-grupo-gim/';
const TZ = 'America/Sao_Paulo';
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

// Data e hora em Brasília, qualquer que seja o fuso do servidor.
function local(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map(x => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { iso: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), label: `${WD[wd]} ${p.day}/${p.month}` };
}

function stats(p) {
  const gd = p.periods && p.periods.day && p.periods.day.gained ? p.periods.day.gained.data : null;
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
    achievements: (p.achievements || []).filter(a => Date.now() - Date.parse(a.createdAt) < 864e5),
  };
}

// Vencedores (empates entram todos), como no painel Destaques do site.
function winners(list, key, dir) {
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; if (Math.abs(d) > 1e-6) return d; } return 0; };
  const sorted = list.slice().sort((a, b) => dir * cmp(key(a), key(b)));
  return sorted.filter(v => cmp(key(v), key(sorted[0])) === 0);
}
const names = list => list.map(v => v.name).join(' e ');

function buildText(data, dayLabel) {
  const list = (data.players || []).map(stats).filter(Boolean);
  if (!list.length) return null;
  const ranked = list.slice().sort((a, b) => b.xp - a.xp);
  const medal = ['🥇', '🥈', '🥉'];
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

const data = JSON.parse(await readFile(FILE, 'utf8'));
let previous = null;
try {
  const r = await fetch(`${SITE}data.json?t=${Date.now()}`);
  if (r.ok) previous = await r.json();
} catch { /* primeira vez */ }

const now = new Date();
const today = local(now);
const day = local(new Date(now.getTime() - 3 * 36e5));   // entre 0h e 2h59, o dia que acabou
let resumo = previous && previous.resumo ? previous.resumo : null;
// Meia-noite: a execução das 0h05 manda; se ela falhar, as de 1h e 2h ainda pegam. Só uma vez por dia.
const due = today.hour <= 2 && (!resumo || resumo.de !== day.iso);

const preview = !resumo || !resumo.de;   // antes do primeiro resumo de meia-noite, o site mostra uma prévia (sem enviar)

if (due || FORCE || preview) {
  const text = buildText(data, due ? day.label : 'últimas 24 horas');
  if (text) {
    console.log(`--- resumo ---\n${text}\n--------------`);
    const sent = due || FORCE ? await sendWhatsApp(text) : false;
    const novo = { de: due ? day.iso : null, rotulo: due ? day.label : 'últimas 24 horas', geradoEm: now.toISOString(), texto: text, enviado: sent };
    // Um teste fora de hora só aparece no site enquanto não existir um resumo de meia-noite.
    if (due || !resumo || !resumo.de) resumo = novo;
  }
} else {
  console.log(`Fora da janela do resumo (agora ${today.hour}h em Brasília); mantendo o último.`);
}

if (resumo) data.resumo = resumo;
await writeFile(FILE, JSON.stringify(data));
