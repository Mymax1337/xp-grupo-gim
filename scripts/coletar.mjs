// Coleta o XP do grupo no Wise Old Man e grava o data.json que o site lê.
// Roda de hora em hora pelo GitHub Actions (.github/workflows/atualizar.yml).
// Uso: node scripts/coletar.mjs <arquivo-de-saida.json>

import { writeFile } from 'node:fs/promises';

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
function slimDetails(d) {
  const skills = {};
  for (const [k, s] of Object.entries(d.latestSnapshot.data.skills)) {
    skills[k] = { metric: k, experience: s.experience, level: s.level, rank: s.rank };
  }
  return { updatedAt: d.updatedAt, combatLevel: d.combatLevel, ehp: d.ehp, latestSnapshot: { data: { skills } } };
}
function slimGained(g) {
  const skills = {};
  for (const [k, s] of Object.entries(g.data.skills)) {
    skills[k] = { metric: k, experience: { gained: s.experience.gained }, level: { gained: s.level.gained, end: s.level.end } };
  }
  return { startsAt: g.startsAt, endsAt: g.endsAt, data: { skills } };
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
  const timeline = (await api(`${path}/snapshots/timeline?metric=overall&period=month`))
    .map(x => ({ value: x.value, date: x.date }))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  return { name, details: slimDetails(details), periods, timeline, updateError };
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

await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), players }));
console.log(`Gravado ${OUT}`);
