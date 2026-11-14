// Comentário da IA local sobre o dia do grupo.
// Este script NÃO roda no GitHub: roda no PC onde está o Ollama (tarefa agendada do Windows, de hora em hora).
// Ele lê o resumo de ontem que já está no site, pede um comentário curto ao modelo local e grava ia.json
// na raiz do repositório (commit + push). O push republica o site, e o coletor leva o ia.json para o data.json.
// Se o comentário de ontem já existe, ou se o Ollama está fechado, ele só sai; a próxima hora tenta de novo.
// Uso: node scripts/comentario.mjs
// Variáveis: IA_TESTE=true só mostra o comentário, sem publicar; FORCAR_IA=true refaz o de ontem; IA_MODELO troca o modelo.

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SITE = 'https://mymax1337.github.io/xp-grupo-gim/';
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.IA_MODELO || 'qwen3.5:9b';
const FORCE = process.env.FORCAR_IA === 'true';
const DRY = process.env.IA_TESTE === 'true';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'ia.json');
const STATE = join(ROOT, '.git', 'ia-tentativas.json');   // dentro de .git: nunca vai para o repositório
const MAX_CHARS = 320;
const AUTHOR = ['-c', 'user.name=IA do Grupo GIM', '-c', 'user.email=100872359+Mymax1337@users.noreply.github.com'];

const log = msg => console.log(`[${new Date().toLocaleString('pt-BR')}] ${msg}`);
// Sem janela para pedir senha: se a credencial do Git faltar, falha em vez de travar a tarefa agendada.
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
}).trim();
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

async function ollama(path, body) {
  const res = await fetch(OLLAMA + path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const SYSTEM = `Você é o narrador zoeiro de um grupo de quatro amigos brasileiros que jogam Old School RuneScape no modo Group Ironman: Serasa, Skol, Zezinho e Elite Br.
Você recebe o resumo de ontem e escreve um comentário curto para o grupo ler.
Como ler o resumo: XP é a experiência ganha no dia; EHP são horas eficientes de treino; "Lanterninha" é quem ganhou menos XP; quem está com 0 XP não jogou.
Regras:
- Português do Brasil, zoeira leve de amigo. Nada de palavrão pesado nem ofensa.
- No máximo 2 frases, em um parágrafo só, com até 280 caracteres.
- Fale de 1 ou 2 destaques (quem mandou bem, quem sumiu). Não repita a lista inteira.
- Não invente nada: só vale o que está no resumo. Só diga que alguém subiu de nível se estiver em "Subiram de nível".
- Se citar um número, copie do resumo exatamente como está (exemplo: 359.831). Não arredonde, não some e não escreva "mil", "k" nem "milhão".
- Sem markdown, sem hashtags, no máximo 2 emojis.`;

// Limpa o que o modelo devolve: raciocínio, markdown e aspas em volta.
function clean(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“'](.*)["”']$/, '$1')
    .trim();
}
// Modelo pequeno troca e arredonda número. Todo número do comentário precisa estar no resumo, do mesmo jeito:
// milhar com ponto (359.831), decimal com vírgula (2,6) e inteiro de dois dígitos ou mais (94).
const NUM = /\d{1,3}(?:\.\d{3})+|\d+,\d+|\d+/g;
function problem(text, source) {
  if (text.length < 30) return 'curto demais';
  if (text.length > MAX_CHARS) return `longo demais (${text.length} caracteres)`;
  if (/\d\s?k\b|\bmil\b|\bmilh(ão|ões)\b/i.test(text)) return 'número arredondado (mil, k ou milhão)';
  const known = new Set(source.match(NUM) || []);
  const wrong = (text.match(NUM) || []).filter(n => !known.has(n) && !(/^\d$/.test(n)));
  if (wrong.length) return `número que não está no resumo: ${wrong.join(', ')}`;
  const typo = (text.match(/\p{Lu}[\p{L}]+/gu) || []).find(misspelledName);
  if (typo) return `nome de jogador escrito errado: ${typo}`;
  return null;
}
// Palavra com maiúscula quase igual ao nome de um jogador (ex.: "Serpa" por "Serasa") é nome errado.
const NAMES = ['serasa', 'skol', 'zezinho', 'elite'];
const NOT_NAMES = new Set(['sera', 'seria', 'serao', 'serio', 'seras', 'sol', 'elites']);   // palavras comuns parecidas
const plain = w => w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
function misspelledName(word) {
  const w = plain(word);
  if (NAMES.includes(w) || NOT_NAMES.has(w)) return false;
  return NAMES.some(n => distance(w, n) <= (n.length >= 6 ? 2 : 1));
}

async function generate(resumo) {
  const tags = await ollama('/api/tags');
  const names = (tags.models || []).map(m => m.name);
  if (!names.length) throw new Error('nenhum modelo instalado no Ollama');
  const model = names.includes(MODEL) ? MODEL : names[0];
  // Se o modelo não estava carregado, ele é liberado da memória logo depois (não fica ocupando a placa de vídeo).
  const loaded = ((await ollama('/api/ps')).models || []).some(m => m.name === model);
  // Sem o link, os asteriscos e os emojis: sobra só o texto, mais fácil para um modelo pequeno ler.
  const source = resumo.texto.replace(/\n*🔗.*$/s, '').replace(/\*/g, '').replace(/[\p{Extended_Pictographic}️]\s?/gu, '');
  const body = {
    model, stream: false, think: false, ...(loaded ? {} : { keep_alive: 0 }),
    options: { temperature: 0.7, num_predict: 160 },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Resumo de ontem (${resumo.rotulo}):\n\n${source}\n\nEscreva o comentário do dia.` },
    ],
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try { res = await ollama('/api/chat', body); }
    catch (e) {
      if (!('think' in body)) throw e;
      delete body.think;   // modelo sem modo de raciocínio recusa o parâmetro
      res = await ollama('/api/chat', body);
    }
    const text = clean(res.message && res.message.content);
    const bad = problem(text, source);
    if (!bad) return { text, model };
    log(`Tentativa ${attempt} descartada (${bad}): ${text.slice(0, 120)}`);
  }
  return { text: null, model };
}

let data;
try {
  const r = await fetch(`${SITE}data.json?t=${Date.now()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  data = await r.json();
} catch (e) { log(`Site fora do ar ou sem internet (${e.message}); tento na próxima hora.`); process.exit(0); }

const resumo = data.resumo;
if (!resumo || !resumo.de || !resumo.texto) { log('O site ainda não tem resumo do dia; nada a comentar.'); process.exit(0); }

if (DRY) {
  try { const r = await generate(resumo); log(r.text ? `Teste (${r.model}), nada foi publicado: ${r.text}` : 'Teste: o modelo não entregou um texto aceitável.'); }
  catch (e) { log(`Ollama indisponível (${e.message}).`); }
  process.exit(0);
}

// Esta cópia do repositório é só do robô. Numa cópia com trabalho em andamento ele não mexe.
const gitErr = e => String(e.stderr || e.message).trim().slice(0, 300);
if (git('status', '--porcelain').split('\n').some(l => l.trim() && !l.endsWith('ia.json'))) {
  log('Esta cópia do repositório tem alterações não salvas; o robô não mexe nela. Use a cópia em ia-bot/repo.');
  process.exit(1);
}
// Traz o que mudou no GitHub e publica comentário que tenha ficado preso aqui (push que falhou na hora anterior).
try { git(...AUTHOR, 'pull', '--rebase', '-q'); } catch (e) { log(`Não consegui atualizar a cópia do repositório: ${gitErr(e)}`); }
try {
  if (git('status', '--porcelain', '--', 'ia.json')) { git('add', 'ia.json'); git(...AUTHOR, 'commit', '-q', '-m', 'IA: comentário pendente', '--', 'ia.json'); }
  if (Number(git('rev-list', '--count', '@{u}..HEAD')) > 0) { git('push', '-q'); log('Publiquei um comentário que estava pendente.'); }
} catch (e) { log(`Ainda não consegui publicar o comentário pendente: ${gitErr(e)}`); }
const current = await readJson(OUT);
if (!FORCE && current && current.de === resumo.de) { log(`Comentário de ${resumo.rotulo} já publicado.`); process.exit(0); }

// Depois de duas rodadas sem um texto aceitável para o mesmo dia, para de insistir (não fica ocupando o PC toda hora).
const state = (await readJson(STATE)) || {};
if (!FORCE && state.de === resumo.de && state.falhas >= 2) { log(`Já tentei duas vezes hoje sem um texto bom para ${resumo.rotulo}; desisto deste dia.`); process.exit(0); }

let result;
try { result = await generate(resumo); }
catch (e) { log(`Ollama indisponível (${e.message}); tento na próxima hora.`); process.exit(0); }
if (!result.text) {
  await writeFile(STATE, JSON.stringify({ de: resumo.de, falhas: (state.de === resumo.de ? state.falhas : 0) + 1 }));
  log('O modelo não entregou um texto aceitável; tento na próxima hora.');
  process.exit(0);
}

await writeFile(OUT, JSON.stringify({ de: resumo.de, rotulo: resumo.rotulo, modelo: result.model, geradoEm: new Date().toISOString(), texto: result.text }, null, 2) + '\n');
log(`Comentário de ${resumo.rotulo} (${result.model}): ${result.text}`);

try {
  git('add', 'ia.json');
  git(...AUTHOR, 'commit', '-q', '-m', `IA: comentário de ${resumo.rotulo}`, '--', 'ia.json');
  try { git('push', '-q'); }
  catch { git(...AUTHOR, 'pull', '--rebase', '-q'); git('push', '-q'); }
  log('Publicado: o site atualiza em uns 2 minutos.');
} catch (e) {
  log(`Gerei o comentário, mas não consegui publicar agora (tento de novo na próxima hora): ${gitErr(e)}`);
  process.exit(1);
}
