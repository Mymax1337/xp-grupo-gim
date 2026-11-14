// Coleta o XP do grupo no Wise Old Man e grava o data.json que o site lê.
// Roda de hora em hora pelo GitHub Actions (.github/workflows/atualizar.yml).
// Uso: node scripts/coletar.mjs <arquivo-de-saida.json>

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const PLAYERS = ['GIM Serasa', 'GIM Skol', 'GIM Zezinho', 'GIM Elite Br'];
const API = 'https://api.wiseoldman.net/v2';
const SITE_DATA = 'https://mymax1337.github.io/xp-grupo-gim/data.json';
const STALE_MS = 50 * 60 * 1000;   // só pede nova leitura dos hiscores se o dado tiver mais de 50 min
const GAP_MS = 3200;               // ~19 pedidos por minuto; o WOM aceita 20 sem chave de API
const HEADERS = { Accept: 'application/json', 'User-Agent': 'xp-grupo-gim (github.com/Mymax1337/xp-grupo-gim)' };
const OUT = process.argv[2] || 'data.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastRequest = 0;

async function api(path, method = 'GET') {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(API + path, { method, headers: HEADERS });
    if (res.status === 429 && attempt < 4) {
      console.log(`Limite do WOM atingido em ${path}; esperando ${30 * (attempt + 1)} s`);
      await sleep(30000 * (attempt + 1));
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`${method} ${path}: ${(body && body.message) || res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }
}

// Guarda só o que o site usa, para o data.json ficar leve.
// Chefes e atividades entram só quando o jogador tem pontuação (o resto vem como -1 no WOM).
function slimDetails(d) {
  const data = d.latestSnapshot.data;
  const skills = {};
  for (const [k, s] of Object.entries(data.skills)) {
    skills[k] = { metric: k, experience: s.experience, level: s.level, rank: s.rank };
  }
  const bosses = {};
  for (const [k, b] of Object.entries(data.bosses || {})) {
    if (b.kills > 0) bosses[k] = { metric: k, kills: b.kills, rank: b.rank };
  }
  const activities = {};
  for (const [k, a] of Object.entries(data.activities || {})) {
    if (a.score > 0) activities[k] = { metric: k, score: a.score, rank: a.rank };
  }
  return {
    updatedAt: d.updatedAt, combatLevel: d.combatLevel, ehp: d.ehp, ehb: d.ehb, ttm: d.ttm,
    latestSnapshot: { data: { skills, bosses, activities } },
  };
}
function slimGained(g) {
  const skills = {};
  for (const [k, s] of Object.entries(g.data.skills)) {
    skills[k] = {
      metric: k,
      experience: { gained: s.experience.gained },
      level: { gained: s.level.gained, end: s.level.end },
      // Sem rank no início ou no fim (-1), a diferença não quer dizer nada.
      rank: { gained: s.rank.start > 0 && s.rank.end > 0 ? s.rank.gained : 0 },
    };
  }
  const bosses = {};
  for (const [k, b] of Object.entries(g.data.bosses || {})) {
    if (b.kills.gained > 0) bosses[k] = { metric: k, kills: { gained: b.kills.gained, end: b.kills.end } };
  }
  const activities = {};
  for (const [k, a] of Object.entries(g.data.activities || {})) {
    if (a.score.gained > 0) activities[k] = { metric: k, score: { gained: a.score.gained, end: a.score.end } };
  }
  // Horas eficientes ganhas no período: EHP (skills) e EHB (chefes), as medidas de eficiência do WOM.
  const hours = k => (g.data.computed && g.data.computed[k] ? { value: { gained: g.data.computed[k].value.gained } } : null);
  return { startsAt: g.startsAt, endsAt: g.endsAt, data: { skills, bosses, activities, computed: { ehp: hours('ehp'), ehb: hours('ehb') } } };
}
// Trechos parados (o mesmo XP em vários registros seguidos) ficam só com a primeira e a última leitura.
function compactTimeline(points) {
  return points.filter((p, i, a) => i === 0 || i === a.length - 1 || p.value !== a[i - 1].value || p.value !== a[i + 1].value);
}

async function collect(name) {
  const path = `/players/${encodeURIComponent(name)}`;
  let details = null;
  let age = Infinity;
  let updateError = null;
  try {
    details = await api(path);
    age = Date.now() - Date.parse(details.updatedAt);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (age > STALE_MS) {
    try { details = await api(path, 'POST'); }
    catch (e) { updateError = e.message; console.log(`Não consegui atualizar ${name}: ${e.message}`); }
  }
  if (!details) throw new Error(`sem dados de ${name}`);

  const periods = {};
  for (const p of ['day', 'week', 'month']) {
    periods[p] = { gained: slimGained(await api(`${path}/gained?period=${p}`)) };
  }
  // A linha do tempo de 30 dias cobre também 24 horas e 7 dias; o site recorta.
  const timeline = compactTimeline((await api(`${path}/snapshots/timeline?metric=overall&period=month`))
    .map(x => ({ value: x.value, date: x.date }))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)));

  // Conquistas (99s, marcos de XP e de abates). Se falhar, o resto do jogador ainda vale.
  let achievements = [];
  try {
    achievements = (await api(`${path}/achievements`))
      .map(a => ({ name: a.name, metric: a.metric, measure: a.measure, threshold: a.threshold, createdAt: a.createdAt }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 40);
  } catch (e) { console.log(`Sem conquistas de ${name}: ${e.message}`); }

  return { name, details: slimDetails(details), periods, timeline, achievements, updateError };
}

// Dados publicados na última hora: usados se algum jogador falhar agora.
let previous = null;
try {
  const r = await fetch(`${SITE_DATA}?t=${Date.now()}`);
  if (r.ok) previous = await r.json();
} catch { /* primeira execução ou site fora do ar */ }

const players = [];
for (const name of PLAYERS) {
  try {
    players.push(await collect(name));
    console.log(`OK   ${name}`);
  } catch (e) {
    console.log(`ERRO ${name}: ${e.message}`);
    const old = previous && previous.players ? previous.players.find(p => p.name === name) : null;
    players.push(old ? { ...old, error: e.message } : { name, error: e.message });
  }
}

if (!players.some(p => p.details && !p.error)) {
  console.error('Nenhum jogador foi atualizado; o site continua com os dados anteriores.');
  process.exit(1);
}

// Comentário da IA local do grupo: ia.json na raiz do repositório, gravado por scripts/comentario.mjs
// no PC onde roda o Ollama. Entra no data.json para a página não precisar de mais um pedido.
let ia = null;
try {
  const j = JSON.parse(await readFile(new URL('../ia.json', import.meta.url), 'utf8'));
  if (j && typeof j.texto === 'string' && j.texto.trim() && typeof j.de === 'string') {
    ia = { de: j.de.slice(0, 10), rotulo: String(j.rotulo || '').slice(0, 20), modelo: String(j.modelo || '').slice(0, 60), geradoEm: j.geradoEm || null, texto: j.texto.trim().slice(0, 600) };
  }
} catch { /* ainda não há comentário */ }

await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), players, ...(ia ? { ia } : {}) }));
console.log(`Gravado ${OUT}`);

// Lista de itens do jogo (wiki do OSRS) para a busca de metas de item.
// Cada item vira [id, nome] ou [id, nome, ícone] quando o arquivo do ícone não é "<nome>.png".
const ITEMS_OUT = join(dirname(OUT), 'items.json');
try {
  const r = await fetch('https://prices.runescape.wiki/api/v1/osrs/mapping', { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const items = (await r.json())
    .filter(x => x && x.name && x.id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(x => (x.icon && x.icon !== `${x.name}.png` ? [x.id, x.name, x.icon] : [x.id, x.name]));
  await writeFile(ITEMS_OUT, JSON.stringify(items));
  console.log(`Gravado ${ITEMS_OUT} (${items.length} itens)`);
} catch (e) {
  console.log(`Lista de itens indisponível (${e.message}); usando a publicada.`);
  try {
    const r = await fetch(SITE_DATA.replace('data.json', 'items.json'));
    if (r.ok) await writeFile(ITEMS_OUT, await r.text());
  } catch { /* a busca de itens aceita texto livre mesmo sem a lista */ }
}
