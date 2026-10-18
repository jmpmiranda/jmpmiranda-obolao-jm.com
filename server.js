/* Bolão de futebol — backend
   Consulta a API real da football-data.org periodicamente (sem precisar de clique)
   e guarda contas/grupos/palpites/histórico no Upstash (produção) ou arquivo local (dev) */

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Pontuacao = require("./public/scoring.js");

// notificações no celular (Web Push). Se o pacote não estiver instalado o resto do app segue funcionando.
let webpush = null;
try { webpush = require("web-push"); } catch { console.warn("⚠️  pacote web-push não instalado — notificações desligadas. Rode npm install."); }

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY || "";
const DB_PATH = path.join(__dirname, "data", "db.json");
const DB_KEY = "bolao_db";
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const POLL_INTERVAL_MS = 3 * 60 * 1000; // varredura completa das 7 ligas (calendário, rodadas novas). Durante jogos, quem acompanha o placar é a consulta rápida (veja tickAoVivo)
const AOVIVO_INTERVAL_MS = 20 * 1000; // consulta rápida: roda só quando existe jogo ao vivo / prestes a começar

const LEAGUE_META = {
  epl: { name: "Premier League", flag: "🏴", country: "Inglaterra", code: "PL" },
  laliga: { name: "La Liga", flag: "🇪🇸", country: "Espanha", code: "PD" },
  seriea: { name: "Serie A", flag: "🇮🇹", country: "Itália", code: "SA" },
  bundesliga: { name: "Bundesliga", flag: "🇩🇪", country: "Alemanha", code: "BL1" },
  ligue1: { name: "Ligue 1", flag: "🇫🇷", country: "França", code: "FL1" },
  champions: { name: "Champions League", flag: "🏆", country: "Europa", code: "CL" },
  brasileirao: { name: "Brasileirão Série A", flag: "🇧🇷", country: "Brasil", code: "BSA" },
};
const LEAGUE_IDS = Object.keys(LEAGUE_META);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_FOTO_CHARS = 320 * 1024; // ~limite generoso pra uma foto já redimensionada no navegador

/* ---------------- persistência: Upstash (produção) ou arquivo local (dev) ---------------- */

async function upstashCommand(cmd) {
  const resp = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!resp.ok) throw new Error(`Upstash respondeu ${resp.status}`);
  return resp.json();
}

function dbVazio() {
  return { users: {}, sessions: {}, groups: {} };
}

async function loadDb() {
  let db;
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const data = await upstashCommand(["GET", DB_KEY]);
      db = data.result ? JSON.parse(data.result) : dbVazio();
    } catch (e) {
      console.error("erro ao ler do Upstash:", e.message);
      db = dbVazio();
    }
  } else {
    try {
      db = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, "utf8")) : dbVazio();
    } catch {
      db = dbVazio();
    }
  }
  db.users = db.users || {};
  db.sessions = db.sessions || {};
  db.groups = db.groups || {};
  db.pushSubs = db.pushSubs || {}; // email -> [{endpoint, keys}] (um por aparelho)
  db.estadoJogos = db.estadoJogos || {}; // jogoId -> {s, h, a} (pra detectar gol/início/fim)
  db.lembretesEnviados = db.lembretesEnviados || {}; // "email:jogoId" -> timestamp
  db.eventosEnviados = db.eventosEnviados || {}; // "jogoId:gol:1-0" -> timestamp (trava contra notificação repetida)
  db.seguindo = db.seguindo || {}; // email -> { [ligaId]: { tudo: bool, times: [teamId] } }
  return db;
}

async function saveDb(db) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      await upstashCommand(["SET", DB_KEY, JSON.stringify(db)]);
    } catch (e) {
      console.error("erro ao salvar no Upstash:", e.message);
    }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("falha ao salvar db:", e.message);
  }
}

/* ---------------- helpers ---------------- */

function hash(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}
function idAnonimo(email) {
  // usado só nas telas de ranking, pra nunca mandar o email de ninguém pro navegador de outra pessoa
  return crypto.createHash("sha256").update(String(email)).digest("hex").slice(0, 16);
}
function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}
function gerarCodigo() {
  let c = "";
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}
function gerarToken() {
  return crypto.randomBytes(24).toString("hex");
}

function autenticar(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ erro: "faça login pra continuar" });
  loadDb().then((db) => {
    const sess = db.sessions[token];
    if (!sess || !db.users[sess.email]) return res.status(401).json({ erro: "sessão expirada, faça login de novo" });
    req.token = token;
    req.userEmail = sess.email;
    req.db = db;
    next();
  }).catch(() => res.status(500).json({ erro: "erro interno" }));
}

/* ---------------- cache de placares (atualizado sozinho) ---------------- */

const scoresCache = Object.fromEntries(LEAGUE_IDS.map((id) => [id, { atualizadoEm: null, jogos: [] }]));
// guarda pra sempre (em memória) todo jogo que já vimos terminar, pra aba Finalizados
// ir crescendo com o tempo sem precisar pedir uma janela de datas gigante pra API de uma vez
const arquivoFinalizados = Object.fromEntries(LEAGUE_IDS.map((id) => [id, {}])); // ligaId -> { [jogoId]: jogo }

function mapStatus(s) {
  if (s === "IN_PLAY" || s === "PAUSED") return "live";
  if (s === "FINISHED" || s === "AWARDED") return "final";
  if (s === "POSTPONED" || s === "SUSPENDED" || s === "CANCELLED") return "adiado";
  return "scheduled";
}

function mapearJogo(m) {
  return {
    id: String(m.id),
    home: m.homeTeam?.name || "?",
    away: m.awayTeam?.name || "?",
    ha: m.homeTeam?.tla || (m.homeTeam?.shortName || "").slice(0, 3).toUpperCase(),
    aa: m.awayTeam?.tla || (m.awayTeam?.shortName || "").slice(0, 3).toUpperCase(),
    haId: m.homeTeam?.id || null,
    aaId: m.awayTeam?.id || null,
    haEscudo: m.homeTeam?.crest || null,
    aaEscudo: m.awayTeam?.crest || null,
    status: mapStatus(m.status),
    hs: m.score?.fullTime?.home ?? 0,
    as: m.score?.fullTime?.away ?? 0,
    minuto: typeof m.minute === "number" ? m.minute : null,
    acrescimo: typeof m.injuryTime === "number" ? m.injuryTime : null,
    matchday: typeof m.matchday === "number" ? m.matchday : null,
    kickoff: m.utcDate,
  };
}

async function buscarLiga(ligaId) {
  const meta = LEAGUE_META[ligaId];
  if (!API_KEY) throw new Error("FOOTBALL_DATA_API_KEY não configurada");
  const hoje = new Date();
  const de = new Date(hoje); de.setDate(de.getDate() - 200); // tentando de novo com mais cuidado — as quebras anteriores podem ter sido falha de build/upload, não da API
  const ate = new Date(hoje); ate.setDate(ate.getDate() + 21); // janela larga: garante que a próxima rodada já apareça assim que a atual acabar
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://api.football-data.org/v4/competitions/${meta.code}/matches?dateFrom=${fmt(de)}&dateTo=${fmt(ate)}`;
  const resp = await fetchFootballData(url);
  if (!resp.ok) throw new Error(`football-data respondeu ${resp.status}`);
  const data = await resp.json();
  const jogos = (data.matches || []).map(mapearJogo);
  jogos.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  return jogos;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* controle ÚNICO e global de chamadas pra API externa — antes, cada função (jogos,
   tabela, últimos jogos de um time) só se preocupava com o próprio ritmo, então
   quando duas rodavam ao mesmo tempo (ex: alguém abrindo a folha de apostar bem na
   hora do poll automático) o total podia passar de 10/min e a API começava a
   recusar pedidos — fazendo os jogos "sumirem" até a próxima tentativa dar certo.
   Agora TODA chamada, de qualquer lugar do código, passa por aqui primeiro. */
const chamadasRecentes = [];
const LIMITE_CHAMADAS_POR_MINUTO = 9; // deixa 1 de margem do limite real (10) da API
async function respeitarLimiteApi() {
  const agora = Date.now();
  while (chamadasRecentes.length && agora - chamadasRecentes[0] > 60000) chamadasRecentes.shift();
  if (chamadasRecentes.length >= LIMITE_CHAMADAS_POR_MINUTO) {
    const espera = 60000 - (Date.now() - chamadasRecentes[0]) + 250;
    await delay(Math.max(espera, 250));
    return respeitarLimiteApi();
  }
  chamadasRecentes.push(Date.now());
}

async function fetchFootballData(url) {
  await respeitarLimiteApi();
  return fetch(url, { headers: { "X-Auth-Token": API_KEY } });
}

/* passa os jogos de uma liga pelo "pipeline": histórico dos grupos + notificações push.
   Carrega o db UMA vez, salva ANTES de enviar os pushes (envio é lento e não pode segurar o db).
   Roda SEMPRE UM DE CADA VEZ (fila): antes, a varredura completa e a consulta rápida podiam rodar
   juntas, os dois enxergavam o mesmo gol como "novo" e mandavam a notificação em dobro. */
let filaProcessamento = Promise.resolve();
function processarLiga(ligaId) {
  const p = filaProcessamento.then(() => processarLigaAgora(ligaId));
  filaProcessamento = p.catch(() => {});
  return p;
}
async function processarLigaAgora(ligaId) {
  const jogos = scoresCache[ligaId].jogos || []; // sempre a versão mais nova que temos, mesmo se esperou na fila
  const db = await loadDb();
  let mudou = atualizarHistoricoDosGrupos(db, ligaId, jogos);
  let envios = [];
  try {
    const r = prepararNotificacoes(db, ligaId, jogos);
    if (r.mudou) mudou = true;
    envios = r.envios;
  } catch (e) { console.error("erro preparando notificações:", e.message); }
  if (mudou) await saveDb(db);
  if (envios.length) await enviarPushes(envios);
}

/* As duas consultas (completa e rápida) às vezes devolvem versões diferentes do mesmo jogo (a API tem cache).
   Pra o placar não "piscar" 1x0 → 0x0 → 1x0 (o que gerava notificação repetida), se chegar uma versão
   mais ANTIGA (status que voltou, ou menos gols) de um jogo que acabamos de ver, mantemos a mais nova por 4 min. */
const RANK_STATUS = { adiado: 0, scheduled: 0, live: 1, final: 2 };
const aceitoEm = new Map(); // jogoId -> quando aceitamos a última versão
function escolherVersao(velho, novo) {
  if (velho) {
    const recente = Date.now() - (aceitoEm.get(novo.id) || 0) < 4 * 60 * 1000;
    const maisAntigo =
      RANK_STATUS[novo.status] < RANK_STATUS[velho.status] ||
      (novo.status === "live" && velho.status === "live" && novo.hs + novo.as < velho.hs + velho.as);
    if (maisAntigo && recente) return velho;
  }
  aceitoEm.set(novo.id, Date.now());
  return novo;
}

/* busca a liga inteira (janela grande de datas) e processa */
async function atualizarLigaCompleta(ligaId) {
  const jogos = await buscarLiga(ligaId);
  const antigos = new Map((scoresCache[ligaId].jogos || []).map((j) => [j.id, j]));
  let terminou = false;
  const mesclados = jogos.map((n) => {
    const o = antigos.get(n.id);
    const v = escolherVersao(o, n);
    if (o && o.status !== "final" && v.status === "final") terminou = true;
    return v;
  });
  scoresCache[ligaId] = { atualizadoEm: Date.now(), jogos: mesclados };
  for (const j of mesclados) {
    if (j.status === "final") arquivoFinalizados[ligaId][j.id] = j;
  }
  if (terminou) agendarAtualizacaoTabela(ligaId);
  await processarLiga(ligaId);
}

let pollandoTudo = false;
async function pollAll() {
  if (pollandoTudo) return; // nunca deixa duas varreduras se atropelarem
  pollandoTudo = true;
  try {
    for (const ligaId of LEAGUE_IDS) {
      try {
        await atualizarLigaCompleta(ligaId);
      } catch (e) {
        console.error(`erro ao buscar ${ligaId}:`, e.message);
      }
      await delay(1500); // espaça as chamadas pra não estourar o limite da API
    }
  } finally {
    pollandoTudo = false;
  }
}

/* ---------------- consulta rápida durante os jogos ---------------- */

// jogo "ativo" = ao vivo agora, ou começando em até 5 min, ou que já devia ter começado (até 3h atrás) e ainda não terminou
function ligasComJogoAtivo() {
  const agora = Date.now();
  return LEAGUE_IDS.filter((id) =>
    (scoresCache[id].jogos || []).some((j) => {
      if (j.status === "live") return true;
      const ko = new Date(j.kickoff).getTime();
      return j.status === "scheduled" && ko - agora < 5 * 60 * 1000 && agora - ko < 3 * 3600 * 1000;
    })
  );
}

// junta os jogos recém-buscados na lista da liga; diz se algum mudou de status ou placar
function mesclarJogos(ligaId, novos) {
  const porId = new Map((scoresCache[ligaId].jogos || []).map((j) => [j.id, j]));
  let mudou = false;
  let terminou = false;
  for (const n of novos) {
    const o = porId.get(n.id);
    const v = escolherVersao(o, n);
    if (!o || o.status !== v.status || o.hs !== v.hs || o.as !== v.as) mudou = true;
    if (o && o.status !== "final" && v.status === "final") terminou = true;
    porId.set(n.id, v);
    if (v.status === "final") arquivoFinalizados[ligaId][v.id] = v;
  }
  const jogos = [...porId.values()].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  scoresCache[ligaId] = { atualizadoEm: Date.now(), jogos };
  return { mudou, terminou };
}

/* UMA chamada só traz os jogos de ontem/hoje/amanhã das 7 ligas — bem mais leve que consultar liga por liga */
async function buscarAoVivo() {
  if (!API_KEY) return;
  const codigos = LEAGUE_IDS.map((id) => LEAGUE_META[id].code).join(",");
  const hoje = new Date();
  const de = new Date(hoje); de.setDate(de.getDate() - 1);
  const ate = new Date(hoje); ate.setDate(ate.getDate() + 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://api.football-data.org/v4/matches?competitions=${codigos}&dateFrom=${fmt(de)}&dateTo=${fmt(ate)}`;
  const resp = await fetchFootballData(url);
  if (!resp.ok) throw new Error(`football-data respondeu ${resp.status}`);
  const data = await resp.json();
  const porLiga = {};
  for (const m of data.matches || []) {
    const ligaId = LEAGUE_IDS.find((id) => LEAGUE_META[id].code === m.competition?.code);
    if (!ligaId) continue;
    (porLiga[ligaId] = porLiga[ligaId] || []).push(mapearJogo(m));
  }
  for (const [ligaId, novos] of Object.entries(porLiga)) {
    const { mudou, terminou } = mesclarJogos(ligaId, novos);
    if (terminou) agendarAtualizacaoTabela(ligaId);
    if (mudou) await processarLiga(ligaId); // só mexe no banco quando saiu gol / começou / acabou
  }
}

let rodandoRapido = false;
async function tickAoVivo() {
  if (rodandoRapido) return;
  const ativas = ligasComJogoAtivo();
  if (ativas.length === 0) return; // sem jogo rolando: não gasta nenhuma consulta
  rodandoRapido = true;
  try {
    try {
      await buscarAoVivo();
    } catch (e) {
      console.error("consulta rápida falhou, tentando liga por liga:", e.message);
      for (const id of ativas) {
        try { await atualizarLigaCompleta(id); } catch (e2) { console.error(`erro ao buscar ${id}:`, e2.message); }
      }
    }
  } finally {
    rodandoRapido = false;
  }
}

/* ---------------- tabela do campeonato (pra estimar probabilidade de vitória) ---------------- */

const standingsCache = Object.fromEntries(LEAGUE_IDS.map((id) => [id, {}])); // ligaId -> { [teamId]: {pontos, jogos, saldoGols} }
// a tabela completa, pra mostrar no app: ligaId -> { atualizadoEm, grupos: [{ nome, linhas: [...] }] }
const tabelaCompleta = Object.fromEntries(LEAGUE_IDS.map((id) => [id, { atualizadoEm: null, grupos: [] }]));

async function buscarTabela(ligaId) {
  const meta = LEAGUE_META[ligaId];
  if (!API_KEY) throw new Error("FOOTBALL_DATA_API_KEY não configurada");
  const url = `https://api.football-data.org/v4/competitions/${meta.code}/standings`;
  const resp = await fetchFootballData(url);
  if (!resp.ok) throw new Error(`standings respondeu ${resp.status}`);
  const data = await resp.json();
  const todas = (data.standings || []).filter((s) => s.type === "TOTAL");
  const lista = todas.length ? todas : (data.standings || []).slice(0, 1);
  const tabela = {};
  const grupos = lista.map((g) => ({
    nome: g.group ? String(g.group).replace(/_/g, " ") : null,
    linhas: (g.table || []).map((l) => {
      if (l.team?.id) tabela[l.team.id] = { pontos: l.points, jogos: l.playedGames, saldoGols: l.goalDifference };
      return {
        pos: l.position, timeId: l.team?.id || null,
        nome: l.team?.shortName || l.team?.name || "?", tla: l.team?.tla || "", escudo: l.team?.crest || null,
        jogos: l.playedGames, v: l.won, e: l.draw, d: l.lost, gp: l.goalsFor, gc: l.goalsAgainst, sg: l.goalDifference, pts: l.points,
      };
    }),
  }));
  return { tabela, grupos };
}

async function atualizarTabela(ligaId) {
  const { tabela, grupos } = await buscarTabela(ligaId);
  standingsCache[ligaId] = tabela;
  tabelaCompleta[ligaId] = { atualizadoEm: Date.now(), grupos };
}

async function pollStandings() {
  for (const ligaId of LEAGUE_IDS) {
    try {
      await atualizarTabela(ligaId);
    } catch (e) {
      console.error(`erro ao buscar tabela ${ligaId}:`, e.message);
    }
    await delay(1500);
  }
}

/* quando um jogo termina, atualiza a tabela daquela liga logo (e de novo depois, porque a API demora um pouco
   pra refletir o resultado na classificação) */
const timersTabela = new Map();
function agendarAtualizacaoTabela(ligaId) {
  const rodar = () => atualizarTabela(ligaId).catch((e) => console.error(`erro ao atualizar tabela ${ligaId}:`, e.message));
  for (const t of timersTabela.get(ligaId) || []) clearTimeout(t);
  rodar();
  timersTabela.set(ligaId, [setTimeout(rodar, 2 * 60 * 1000), setTimeout(rodar, 6 * 60 * 1000)]);
}

/* estimativa simples de probabilidade a partir da tabela (pontos por jogo + saldo de gols
   por jogo + vantagem de mandante) — NÃO são odds reais de casa de apostas */
function estimarProbabilidades(casa, fora) {
  if (!casa || !fora || !casa.jogos || !fora.jogos) return null;
  const forcaCasa = casa.pontos / casa.jogos + 0.12 * (casa.saldoGols / casa.jogos) + 0.35;
  const forcaFora = fora.pontos / fora.jogos + 0.12 * (fora.saldoGols / fora.jogos);
  const diff = forcaCasa - forcaFora;
  const sig = 1 / (1 + Math.exp(-diff * 1.3));
  const baseEmpate = Math.max(0.16, 0.26 - Math.abs(diff) * 0.05);
  const pCasa = Math.round(sig * (1 - baseEmpate) * 100);
  const pEmpate = Math.round(baseEmpate * 100);
  const pFora = 100 - pCasa - pEmpate;
  return { casa: pCasa, empate: pEmpate, fora: pFora };
}

/* registra, para cada grupo dessa liga, uma "foto" da classificação
   sempre que o número de jogos encerrados mudar — é isso que vira o gráfico */
function atualizarHistoricoDosGrupos(db, ligaId, jogos) {
  const finalizados = jogos.filter((j) => j.status === "final").sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const jogosEncerrados = finalizados.length;
  const ultimoJogo = finalizados.length > 0 ? finalizados[finalizados.length - 1] : null;
  let mudou = false;
  for (const [code, g] of Object.entries(db.groups)) {
    if (g.liga !== ligaId) continue;
    if (g.ultimoJogosEncerrados === jogosEncerrados) continue;
    const membrosComNome = {};
    for (const email of Object.keys(g.membros)) {
      const u = db.users[email];
      membrosComNome[email] = { nome: u ? u.nome : "?" };
    }
    const linhas = Pontuacao.classificacao(membrosComNome, g.palpites, jogos);
    g.historico = g.historico || [];
    g.historico.push({
      jogosEncerrados,
      quando: Date.now(),
      ultimoJogo: ultimoJogo ? `${ultimoJogo.ha}x${ultimoJogo.aa}` : null,
      linhas: linhas.map((l) => ({ slug: idAnonimo(l.slug), jogador: l.jogador, total: l.total, colocacao: l.colocacao })),
    });
    if (g.historico.length > 40) g.historico = g.historico.slice(-40);
    g.ultimoJogosEncerrados = jogosEncerrados;
    mudou = true;
  }
  return mudou;
}

/* ---------------- notificações no celular (Web Push) ----------------
   O servidor (que fica ligado 24h) detecta início de jogo, gol e fim de jogo e manda
   uma notificação pro celular de cada participante — não depende do app estar aberto.
   Todas as notificações de um mesmo jogo usam a mesma "tag", então o celular troca a
   anterior pela nova: na tela de bloqueio fica sempre UMA notificação por jogo com o
   placar mais recente (é o mais perto de "placar ao vivo" que um app web consegue). */

const VAPID_PATH = path.join(__dirname, "data", "vapid.json");
const VAPID_KEY = "bolao_vapid"; // guardado À PARTE do db principal, pra nunca precisar regravar o db inteiro no boot
let VAPID = null; // { pub, priv }

async function iniciarPush() {
  if (!webpush) return;
  let pub = process.env.VAPID_PUBLIC_KEY || "";
  let priv = process.env.VAPID_PRIVATE_KEY || "";
  if (!pub || !priv) {
    let chaves = null;
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      try {
        const data = await upstashCommand(["GET", VAPID_KEY]);
        chaves = data.result ? JSON.parse(data.result) : null;
        if (!chaves) {
          chaves = webpush.generateVAPIDKeys();
          await upstashCommand(["SET", VAPID_KEY, JSON.stringify(chaves)]);
        }
      } catch (e) {
        console.error("push: não consegui ler/gravar as chaves no Upstash:", e.message);
        return;
      }
    } else {
      try { chaves = fs.existsSync(VAPID_PATH) ? JSON.parse(fs.readFileSync(VAPID_PATH, "utf8")) : null; } catch { chaves = null; }
      if (!chaves) {
        chaves = webpush.generateVAPIDKeys();
        try {
          fs.mkdirSync(path.dirname(VAPID_PATH), { recursive: true });
          fs.writeFileSync(VAPID_PATH, JSON.stringify(chaves));
        } catch (e) { console.error("push: falha ao gravar chaves:", e.message); }
      }
    }
    pub = chaves.publicKey;
    priv = chaves.privateKey;
  }
  const assunto = process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || "mailto:bolao@localhost.dev";
  webpush.setVapidDetails(assunto, pub, priv);
  VAPID = { pub, priv };
  console.log("🔔 notificações push ligadas");
}

const JANELA_ANTES_MS = 36 * 3600 * 1000; // só acompanha jogos de 12h atrás até 36h à frente
const JANELA_DEPOIS_MS = 12 * 3600 * 1000;
const IDADE_MAX_EVENTO_MS = 4 * 3600 * 1000; // se o servidor "dormiu" e acordou muito depois, não manda notificação velha

/* a pessoa recebe notificação de um jogo só se SEGUE um dos times dele (ou marcou "seguir tudo" naquela liga) */
function segueJogo(db, email, ligaId, j) {
  const s = db.seguindo[email] && db.seguindo[email][ligaId];
  if (!s) return false;
  if (s.tudo) return true;
  const times = s.times || [];
  return (j.haId != null && times.includes(j.haId)) || (j.aaId != null && times.includes(j.aaId));
}

function linhasDePalpite(db, email, ligaId, j, comoEstaValendo) {
  const meusGrupos = Object.values(db.groups).filter((g) => g.liga === ligaId && g.membros[email]);
  const linhas = [];
  for (const g of meusGrupos.slice(0, 3)) {
    const p = g.palpites[email] && g.palpites[email][j.id];
    const nomeGrupo = meusGrupos.length > 1 ? ` (${g.nome})` : "";
    if (!p) { linhas.push(`Sem palpite seu${nomeGrupo}`); continue; }
    let txt = `Seu palpite${nomeGrupo}: ${p.h ?? 0}–${p.a ?? 0}`;
    const pts = Pontuacao.pointsFor(p, j);
    if (pts && comoEstaValendo === "final") txt += ` → ${pts.total} pts`;
    else if (pts && comoEstaValendo === "live") txt += ` · vale ${pts.total} pts agora`;
    linhas.push(txt);
  }
  return linhas;
}

/* Só CALCULA o que precisa ser enviado e atualiza o estado em memória do db — quem salva
   e quem envia é o processarLiga (salva primeiro, depois manda os pushes). */
function prepararNotificacoes(db, ligaId, jogos) {
  const resultado = { mudou: false, envios: [] };
  if (!webpush || !VAPID) return resultado;
  const agora = Date.now();
  const grupos = Object.values(db.groups).filter((g) => g.liga === ligaId);
  const inscritos = new Set();
  for (const g of grupos) {
    for (const email of Object.keys(g.membros)) if ((db.pushSubs[email] || []).length) inscritos.add(email);
  }

  const empurrar = (email, payload, topic, ttl) => {
    for (const sub of db.pushSubs[email] || []) resultado.envios.push({ email, sub, payload, topic, ttl });
  };

  for (const j of jogos) {
    const ko = new Date(j.kickoff).getTime();
    const naJanela = ko > agora - JANELA_DEPOIS_MS && ko < agora + JANELA_ANTES_MS;
    const prev = db.estadoJogos[j.id];
    if (!naJanela) {
      if (prev) { delete db.estadoJogos[j.id]; resultado.mudou = true; }
      continue;
    }
    const atual = { s: j.status, h: j.hs, a: j.as };

    if (!prev) {
      // primeira vez que vemos esse jogo: só registra, não notifica (evita enxurrada no primeiro deploy)
      db.estadoJogos[j.id] = atual;
      resultado.mudou = true;
    } else if (RANK_STATUS[atual.s] < RANK_STATUS[prev.s]) {
      // dado velho chegando atrasado da API (o jogo "voltou" de status): ignora, não mexe no estado nem avisa
    } else if (prev.s !== atual.s || prev.h !== atual.h || prev.a !== atual.a) {
      db.estadoJogos[j.id] = atual;
      resultado.mudou = true;

      let tipo = null;
      if (atual.s === "final" && prev.s !== "final") tipo = "fim";
      else if (atual.s === "live" && prev.s === "scheduled") tipo = atual.h + atual.a > 0 ? "gol" : "inicio";
      else if (atual.s === "live" && prev.s === "live" && (atual.h > prev.h || atual.a > prev.a)) tipo = "gol";
      // placar que DIMINUI (VAR ou dado velho da API): só atualiza o estado, sem avisar

      // trava final contra notificação repetida: cada evento (ex.: "gol, 1x0") só é enviado uma vez, aconteça o que acontecer
      let jaEnviado = false;
      if (tipo) {
        const chaveEvento = tipo === "gol" ? `${j.id}:gol:${atual.h}-${atual.a}` : `${j.id}:${tipo}`;
        jaEnviado = !!db.eventosEnviados[chaveEvento];
        if (!jaEnviado) db.eventosEnviados[chaveEvento] = agora;
      }

      if (tipo && !jaEnviado && inscritos.size && agora - ko < IDADE_MAX_EVENTO_MS) {
        const placar = `${j.ha} ${j.hs} x ${j.as} ${j.aa}`;
        const minuto = j.minuto != null ? ` · ${j.minuto}'` : "";
        const marcou = atual.h > prev.h ? j.ha : atual.a > prev.a ? j.aa : null;
        let titulo, fixa, ttl, valendo;
        if (tipo === "inicio") { titulo = `🟢 Começou! ${j.ha} x ${j.aa}`; fixa = true; ttl = 600; valendo = "live"; }
        else if (tipo === "gol") {
          titulo = `⚽ GOL${marcou ? ` do ${marcou}` : ""}! ${placar}${minuto}`;
          fixa = true; ttl = 600; valendo = "live";
        } else { titulo = `🏁 Fim de jogo: ${placar}`; fixa = false; ttl = 3600; valendo = "final"; }

        for (const email of inscritos) {
          if (!segueJogo(db, email, ligaId, j)) continue; // só recebe quem segue o time da casa ou o visitante (ou "seguir tudo")
          const corpo = [`${j.home} x ${j.away}`, ...linhasDePalpite(db, email, ligaId, j, valendo)].join("\n");
          empurrar(email, { title: titulo, body: corpo, tag: `jogo-${j.id}`, renotify: true, fixa, url: "/" }, `j${j.id}`, ttl);
        }
      }
    }

    // lembrete 1h antes — só pra quem ainda NÃO palpitou (as notificações acima chegam pra todo mundo, palpitou ou não)
    const faltam = ko - agora;
    if (j.status === "scheduled" && faltam > 0 && faltam <= 3600 * 1000) {
      for (const g of grupos) {
        for (const email of Object.keys(g.membros)) {
          if (!(db.pushSubs[email] || []).length) continue;
          if (!segueJogo(db, email, ligaId, j)) continue;
          if (g.palpites[email] && g.palpites[email][j.id]) continue;
          const chave = `${email}:${j.id}`;
          if (db.lembretesEnviados[chave]) continue;
          db.lembretesEnviados[chave] = agora;
          resultado.mudou = true;
          empurrar(email, {
            title: "⏰ Falta 1h pro jogo!",
            body: `${j.home} x ${j.away} começa em breve e você ainda não deu seu palpite no ${g.nome}.`,
            tag: `lembrete-${j.id}`, renotify: true, url: "/",
          }, `l${j.id}`, 1800);
        }
      }
    }
  }

  for (const mapa of [db.lembretesEnviados, db.eventosEnviados]) {
    for (const [chave, quando] of Object.entries(mapa)) {
      if (agora - quando > 2 * 24 * 3600 * 1000) { delete mapa[chave]; resultado.mudou = true; }
    }
  }
  return resultado;
}

async function enviarPushes(envios) {
  const mortos = [];
  await Promise.all(envios.map(async (e) => {
    try {
      await webpush.sendNotification(e.sub, JSON.stringify(e.payload), { TTL: e.ttl || 600, urgency: "high", topic: e.topic });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) mortos.push({ email: e.email, endpoint: e.sub.endpoint });
      else console.error("push falhou:", err.statusCode || err.message);
    }
  }));
  if (mortos.length) { // aparelho desinstalou o app / revogou a permissão: limpa da lista
    const db = await loadDb();
    for (const m of mortos) db.pushSubs[m.email] = (db.pushSubs[m.email] || []).filter((s) => s.endpoint !== m.endpoint);
    await saveDb(db);
  }
}

/* ---------------- rotas de conta ---------------- */

app.post("/api/conta/criar", async (req, res) => {
  const { email, senha, nome } = req.body || {};
  const emailKey = String(email || "").trim().toLowerCase();
  if (!emailValido(emailKey)) return res.status(400).json({ erro: "email inválido" });
  if (!senha || senha.length < 6) return res.status(400).json({ erro: "a senha precisa ter pelo menos 6 caracteres" });
  if (!nome || !nome.trim()) return res.status(400).json({ erro: "informe seu apelido" });
  const db = await loadDb();
  if (db.users[emailKey]) return res.status(409).json({ erro: "já existe uma conta com esse email" });
  const codigoRecuperacao = gerarCodigo() + gerarCodigo(); // 12 caracteres — só é mostrado essa uma vez
  db.users[emailKey] = {
    senhaHash: hash(senha), nome: nome.trim(), foto: null, criadoEm: Date.now(),
    codigoRecuperacaoHash: hash(codigoRecuperacao),
  };
  const token = gerarToken();
  db.sessions[token] = { email: emailKey, criadoEm: Date.now() };
  await saveDb(db);
  res.json({ token, email: emailKey, nome: db.users[emailKey].nome, codigoRecuperacao });
});

app.post("/api/conta/recuperar", async (req, res) => {
  const { email, codigoRecuperacao, novaSenha } = req.body || {};
  const emailKey = String(email || "").trim().toLowerCase();
  if (!novaSenha || novaSenha.length < 6) return res.status(400).json({ erro: "a nova senha precisa ter pelo menos 6 caracteres" });
  const db = await loadDb();
  const u = db.users[emailKey];
  if (!u || !u.codigoRecuperacaoHash || u.codigoRecuperacaoHash !== hash(String(codigoRecuperacao || "").trim().toUpperCase())) {
    return res.status(401).json({ erro: "email ou código de recuperação incorretos" });
  }
  u.senhaHash = hash(novaSenha);
  // por segurança, derruba todas as sessões abertas dessa conta depois de trocar a senha
  for (const [tok, sess] of Object.entries(db.sessions)) {
    if (sess.email === emailKey) delete db.sessions[tok];
  }
  await saveDb(db);
  res.json({ ok: true });
});

app.post("/api/conta/entrar", async (req, res) => {
  const { email, senha } = req.body || {};
  const emailKey = String(email || "").trim().toLowerCase();
  const db = await loadDb();
  const u = db.users[emailKey];
  if (!u || u.senhaHash !== hash(senha || "")) return res.status(401).json({ erro: "email ou senha incorretos" });
  const token = gerarToken();
  db.sessions[token] = { email: emailKey, criadoEm: Date.now() };
  await saveDb(db);
  res.json({ token, email: emailKey, nome: u.nome });
});

app.get("/api/conta/eu", autenticar, (req, res) => {
  const u = req.db.users[req.userEmail];
  res.json({ email: req.userEmail, nome: u.nome, foto: u.foto || null });
});

app.post("/api/conta/sair", autenticar, async (req, res) => {
  delete req.db.sessions[req.token];
  await saveDb(req.db);
  res.json({ ok: true });
});

app.post("/api/conta/nome", autenticar, async (req, res) => {
  const { nome } = req.body || {};
  if (!nome || !nome.trim()) return res.status(400).json({ erro: "informe um apelido" });
  req.db.users[req.userEmail].nome = nome.trim();
  await saveDb(req.db);
  res.json({ ok: true, nome: nome.trim() });
});

app.post("/api/conta/foto", autenticar, async (req, res) => {
  const { foto } = req.body || {};
  if (!foto || typeof foto !== "string" || !foto.startsWith("data:image/")) {
    return res.status(400).json({ erro: "foto inválida" });
  }
  if (foto.length > MAX_FOTO_CHARS) return res.status(413).json({ erro: "essa foto ficou grande demais, tenta outra" });
  req.db.users[req.userEmail].foto = foto;
  await saveDb(req.db);
  res.json({ ok: true });
});

app.get("/api/conta/grupos", autenticar, (req, res) => {
  const lista = [];
  for (const [code, g] of Object.entries(req.db.groups)) {
    if (g.membros[req.userEmail]) lista.push({ code, nome: g.nome, liga: g.liga });
  }
  res.json({ grupos: lista });
});

/* ---------------- rotas de notificação push ---------------- */

app.get("/health", (req, res) => res.json({ ok: true })); // usado pra manter o servidor acordado (veja o README)

app.get("/api/push/chave", (req, res) => {
  res.json({ chave: VAPID ? VAPID.pub : null });
});

app.post("/api/push/inscrever", autenticar, async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!VAPID) return res.status(503).json({ erro: "notificações ainda não estão ligadas no servidor" });
  if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://") || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ erro: "inscrição inválida" });
  }
  const db = req.db;
  const novo = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
  const lista = (db.pushSubs[req.userEmail] = db.pushSubs[req.userEmail] || []);
  const jaExiste = lista.some((x) => x.endpoint === novo.endpoint && x.keys.p256dh === novo.keys.p256dh && x.keys.auth === novo.keys.auth);
  let mudou = false;
  // se esse mesmo aparelho estava ligado a OUTRA conta, passa pra essa (um celular = uma conta)
  for (const [email, subs] of Object.entries(db.pushSubs)) {
    if (email === req.userEmail) continue;
    const filtradas = subs.filter((x) => x.endpoint !== novo.endpoint);
    if (filtradas.length !== subs.length) { db.pushSubs[email] = filtradas; mudou = true; }
  }
  if (!jaExiste) {
    db.pushSubs[req.userEmail] = lista.filter((x) => x.endpoint !== novo.endpoint).concat(novo).slice(-10);
    mudou = true;
  }
  if (mudou) await saveDb(db);
  res.json({ ok: true });
});

app.post("/api/push/cancelar", autenticar, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  const lista = req.db.pushSubs[req.userEmail] || [];
  const filtrada = lista.filter((x) => x.endpoint !== endpoint);
  if (filtrada.length !== lista.length) {
    req.db.pushSubs[req.userEmail] = filtrada;
    await saveDb(req.db);
  }
  res.json({ ok: true });
});

/* ---------------- tabela do campeonato, "seguir" times e escalação ---------------- */

app.get("/api/ligas/:ligaId/tabela", autenticar, (req, res) => {
  const t = tabelaCompleta[req.params.ligaId];
  if (!t) return res.status(404).json({ erro: "liga inválida" });
  res.json(t);
});

function estadoSeguindo(db, email, ligaId) {
  const s = db.seguindo[email] && db.seguindo[email][ligaId];
  return { tudo: !!(s && s.tudo), times: s && Array.isArray(s.times) ? s.times : [] };
}
function idsDeTodosOsTimes(ligaId) {
  const ids = new Set();
  for (const g of tabelaCompleta[ligaId].grupos) for (const l of g.linhas) if (l.timeId) ids.add(l.timeId);
  for (const j of scoresCache[ligaId].jogos || []) { if (j.haId) ids.add(j.haId); if (j.aaId) ids.add(j.aaId); }
  return [...ids];
}
function gravarSeguindo(db, email, ligaId, estado) {
  db.seguindo[email] = db.seguindo[email] || {};
  db.seguindo[email][ligaId] = { tudo: estado.tudo, times: estado.times };
}

app.get("/api/seguindo/:ligaId", autenticar, (req, res) => {
  if (!LEAGUE_META[req.params.ligaId]) return res.status(404).json({ erro: "liga inválida" });
  res.json(estadoSeguindo(req.db, req.userEmail, req.params.ligaId));
});

app.post("/api/seguindo/:ligaId/time/:teamId", autenticar, async (req, res) => {
  const { ligaId } = req.params;
  const teamId = Number(req.params.teamId);
  if (!LEAGUE_META[ligaId] || !Number.isInteger(teamId)) return res.status(400).json({ erro: "dados inválidos" });
  const seguir = !!(req.body && req.body.seguir);
  let { tudo, times } = estadoSeguindo(req.db, req.userEmail, ligaId);
  if (seguir) {
    if (!tudo && !times.includes(teamId)) times = [...times, teamId];
  } else if (tudo) { // estava em "seguir tudo": vira "todos, menos esse"
    times = idsDeTodosOsTimes(ligaId).filter((id) => id !== teamId);
    tudo = false;
  } else {
    times = times.filter((id) => id !== teamId);
  }
  const estado = { tudo, times };
  gravarSeguindo(req.db, req.userEmail, ligaId, estado);
  await saveDb(req.db);
  res.json(estado);
});

app.post("/api/seguindo/:ligaId/tudo", autenticar, async (req, res) => {
  const { ligaId } = req.params;
  if (!LEAGUE_META[ligaId]) return res.status(400).json({ erro: "liga inválida" });
  const estado = { tudo: !!(req.body && req.body.seguir), times: [] };
  gravarSeguindo(req.db, req.userEmail, ligaId, estado);
  await saveDb(req.db);
  res.json(estado);
});

/* Escalação: vem da football-data.org, mas o plano GRÁTIS dela não inclui escalações (só os planos pagos).
   Se a API não mandar, devolvemos disponivel:false e o app mostra um aviso; se o plano mudar, passa a funcionar sozinho. */
const escalacaoCache = new Map(); // jogoId -> { em, dados }
function mapearTimeEscalacao(t) {
  const jog = (p) => ({ nome: p.name || "?", camisa: p.shirtNumber ?? null, posicao: p.position || null });
  return {
    formacao: t?.formation || null,
    tecnico: t?.coach?.name || null,
    titulares: (t?.lineup || []).map(jog),
    reservas: (t?.bench || []).map(jog),
  };
}
app.get("/api/jogos/:jogoId/escalacao", autenticar, async (req, res) => {
  const { jogoId } = req.params;
  if (!/^\d+$/.test(jogoId)) return res.status(400).json({ erro: "jogo inválido" });
  const existe = LEAGUE_IDS.some((id) => (scoresCache[id].jogos || []).some((j) => j.id === jogoId));
  if (!existe) return res.status(404).json({ erro: "jogo não encontrado" });
  const guardado = escalacaoCache.get(jogoId);
  if (guardado && Date.now() - guardado.em < 90 * 1000) return res.json(guardado.dados);
  let dados = { disponivel: false, casa: null, fora: null };
  try {
    if (!API_KEY) throw new Error("sem chave da API");
    await respeitarLimiteApi();
    const resp = await fetch(`https://api.football-data.org/v4/matches/${jogoId}`, {
      headers: { "X-Auth-Token": API_KEY, "X-Unfold-Lineups": "true" },
    });
    if (resp.ok) {
      const m = await resp.json();
      const casa = mapearTimeEscalacao(m.homeTeam);
      const fora = mapearTimeEscalacao(m.awayTeam);
      dados = { disponivel: casa.titulares.length + fora.titulares.length > 0, casa, fora };
    }
  } catch (e) { console.error("escalação:", e.message); }
  escalacaoCache.set(jogoId, { em: Date.now(), dados });
  res.json(dados);
});

/* ---------------- rotas de placares/ligas ---------------- */

app.get("/api/ligas", (req, res) => {
  res.json(LEAGUE_IDS.map((id) => ({ id, ...LEAGUE_META[id] })));
});

app.get("/api/scores/:liga", (req, res) => {
  const liga = req.params.liga;
  if (!LEAGUE_META[liga]) return res.status(400).json({ erro: "liga inválida" });
  const c = scoresCache[liga];
  const tabela = standingsCache[liga] || {};
  const jogosJanela = c.jogos.map((j) => ({
    ...j,
    probabilidade: estimarProbabilidades(tabela[j.haId], tabela[j.aaId]),
  }));
  // soma os jogos da janela atual (com placar/status fresquinhos) com tudo que já
  // vimos terminar antes e não está mais nessa janela, pra Finalizados não perder nada
  const idsNaJanela = new Set(jogosJanela.map((j) => j.id));
  const antigos = Object.values(arquivoFinalizados[liga] || {})
    .filter((j) => !idsNaJanela.has(j.id))
    .map((j) => ({ ...j, probabilidade: null }));
  const jogos = [...jogosJanela, ...antigos].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  res.json({ liga, meta: LEAGUE_META[liga], atualizadoEm: c.atualizadoEm, jogos, apiConfigurada: !!API_KEY });
});

/* ---------------- rotas de grupos ---------------- */

app.post("/api/grupos", autenticar, async (req, res) => {
  const { nome, senha, liga } = req.body || {};
  if (!nome || !senha || !LEAGUE_META[liga]) {
    return res.status(400).json({ erro: "preencha nome do grupo, senha e liga" });
  }
  const db = req.db;
  let code;
  do { code = gerarCodigo(); } while (db.groups[code]);

  // já nasce com um ponto de partida no histórico, em vez de esperar o segundo jogo
  // terminar pra desenhar a primeira linha do gráfico
  const jogosAgora = (scoresCache[liga] && scoresCache[liga].jogos) || [];
  const jogosEncerradosAgora = jogosAgora.filter((j) => j.status === "final").length;

  db.groups[code] = {
    nome, senhaHash: hash(senha), liga, criadoPorEmail: req.userEmail, criadoEm: Date.now(),
    membros: { [req.userEmail]: { entrouEm: Date.now() } },
    palpites: {},
    historico: [{
      jogosEncerrados: jogosEncerradosAgora,
      quando: Date.now(),
      ultimoJogo: null,
      linhas: [{ slug: idAnonimo(req.userEmail), jogador: db.users[req.userEmail].nome, total: 0, colocacao: 1 }],
    }],
    ultimoJogosEncerrados: jogosEncerradosAgora,
  };
  await saveDb(db);
  res.json({ code, nome, liga, souCriador: true });
});

app.post("/api/grupos/:code/entrar", autenticar, async (req, res) => {
  const { senha } = req.body || {};
  const db = req.db;
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado. confira o código" });

  if (!g.membros[req.userEmail]) {
    if (g.removidos && g.removidos[req.userEmail]) {
      return res.status(403).json({ erro: "você foi removido deste grupo pelo criador" });
    }
    if (g.senhaHash !== hash(senha || "")) return res.status(401).json({ erro: "senha incorreta" });
    const meuNome = (db.users[req.userEmail].nome || "").trim().toLowerCase();
    const conflito = Object.keys(g.membros).some(
      (email) => email !== req.userEmail && (db.users[email]?.nome || "").trim().toLowerCase() === meuNome
    );
    if (conflito) {
      return res.status(409).json({ erro: `já tem alguém chamado "${db.users[req.userEmail].nome}" nesse grupo — mude seu apelido em Configurações e tente de novo` });
    }
    g.membros[req.userEmail] = { entrouEm: Date.now() };
    await saveDb(db);
  }
  res.json({ code: req.params.code, nome: g.nome, liga: g.liga, souCriador: g.criadoPorEmail === req.userEmail });
});

app.get("/api/grupos/:code", autenticar, (req, res) => {
  const g = req.db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  if (!g.membros[req.userEmail]) return res.status(403).json({ erro: "você não faz parte desse grupo" });
  res.json({
    code: req.params.code, nome: g.nome, liga: g.liga,
    membros: Object.keys(g.membros).length,
    souCriador: g.criadoPorEmail === req.userEmail,
  });
});

app.post("/api/grupos/:code/sair", autenticar, async (req, res) => {
  const db = req.db;
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  delete g.membros[req.userEmail];
  delete g.palpites[req.userEmail];
  await saveDb(db);
  res.json({ ok: true });
});

app.post("/api/grupos/:code/trocar-senha", autenticar, async (req, res) => {
  const { novaSenha } = req.body || {};
  const db = req.db;
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  if (g.criadoPorEmail !== req.userEmail) return res.status(403).json({ erro: "só quem criou o grupo pode trocar a senha" });
  if (!novaSenha || novaSenha.length < 3) return res.status(400).json({ erro: "escolha uma senha" });
  g.senhaHash = hash(novaSenha);
  g.removidos = {}; // a senha nova é a nova "porta de entrada": quem foi removido antes pode voltar se receber a senha nova
  await saveDb(db);
  res.json({ ok: true });
});

/* só o criador pode tirar alguém do grupo. O participante perde os palpites daquele grupo e
   não consegue voltar com a senha antiga (só depois que o criador trocar a senha do grupo). */
app.post("/api/grupos/:code/membros/:id/remover", autenticar, async (req, res) => {
  const db = req.db;
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  if (g.criadoPorEmail !== req.userEmail) return res.status(403).json({ erro: "só quem criou o grupo pode remover participantes" });
  const alvo = Object.keys(g.membros).find((email) => idAnonimo(email) === req.params.id);
  if (!alvo) return res.status(404).json({ erro: "participante não encontrado nesse grupo" });
  if (alvo === req.userEmail) return res.status(400).json({ erro: "você é o criador do grupo — use \"Sair deste grupo\" se quiser sair" });
  delete g.membros[alvo];
  delete g.palpites[alvo];
  g.removidos = g.removidos || {};
  g.removidos[alvo] = Date.now();
  for (const h of g.historico || []) h.linhas = (h.linhas || []).filter((l) => l.slug !== req.params.id);
  await saveDb(db);
  res.json({ ok: true });
});

app.get("/api/grupos/:code/palpites", autenticar, (req, res) => {
  const g = req.db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  if (!g.membros[req.userEmail]) return res.status(403).json({ erro: "você não faz parte desse grupo" });
  res.json({ palpites: g.palpites[req.userEmail] || {} });
});

app.post("/api/grupos/:code/palpites", autenticar, async (req, res) => {
  const { palpites } = req.body || {};
  const db = req.db;
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  if (!g.membros[req.userEmail]) return res.status(400).json({ erro: "entre no grupo antes de continuar" });
  g.palpites[req.userEmail] = palpites || {};
  await saveDb(db);
  res.json({ ok: true });
});

/* acha a rodada (matchday) mais recente em que TODOS os jogos já terminaram */
function ultimaRodadaCompleta(jogos) {
  const porRodada = {};
  for (const j of jogos) {
    if (j.matchday == null) continue;
    (porRodada[j.matchday] = porRodada[j.matchday] || []).push(j);
  }
  const completas = Object.keys(porRodada).map(Number).filter((md) => porRodada[md].every((j) => j.status === "final"));
  if (completas.length === 0) return null;
  const maior = Math.max(...completas);
  return { matchday: maior, jogos: porRodada[maior] };
}

app.get("/api/grupos/:code/classificacao", autenticar, (req, res) => {
  const g = req.db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  if (!g.membros[req.userEmail]) return res.status(403).json({ erro: "você não faz parte desse grupo" });
  const jogos = (scoresCache[g.liga] && scoresCache[g.liga].jogos) || [];
  const membrosComNome = {};
  for (const email of Object.keys(g.membros)) {
    const u = req.db.users[email];
    membrosComNome[email] = { nome: u ? u.nome : "?" };
  }
  const linhas = Pontuacao.classificacao(membrosComNome, g.palpites, jogos).map((l) => {
    const email = l.slug;
    return { ...l, slug: idAnonimo(email), foto: (req.db.users[email] && req.db.users[email].foto) || null };
  });

  let melhorRodada = null;
  const rodada = ultimaRodadaCompleta(jogos);
  if (rodada) {
    const linhasRodada = Pontuacao.classificacao(membrosComNome, g.palpites, rodada.jogos);
    if (linhasRodada.length > 0 && linhasRodada[0].total > 0) {
      const top = linhasRodada[0];
      melhorRodada = {
        jogador: top.jogador,
        pontos: top.total,
        matchday: rodada.matchday,
        foto: (req.db.users[top.slug] && req.db.users[top.slug].foto) || null,
      };
    }
  }

  res.json({ classificacao: linhas, meuId: idAnonimo(req.userEmail), melhorRodada, atualizadoEm: scoresCache[g.liga]?.atualizadoEm || null });
});

app.get("/api/grupos/:code/historico", autenticar, (req, res) => {
  const g = req.db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  if (!g.membros[req.userEmail]) return res.status(403).json({ erro: "você não faz parte desse grupo" });
  res.json({ historico: g.historico || [], meuId: idAnonimo(req.userEmail) });
});

/* mostra o palpite de cada pessoa do grupo num jogo específico — só depois que o jogo
   começa (senão daria pra copiar o palpite de alguém antes de decidir o seu) */
app.get("/api/grupos/:code/jogo/:jogoId/palpites", autenticar, (req, res) => {
  const g = req.db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
  if (!g.membros[req.userEmail]) return res.status(403).json({ erro: "você não faz parte desse grupo" });
  const jogos = (scoresCache[g.liga] && scoresCache[g.liga].jogos) || [];
  const jogo = jogos.find((j) => j.id === req.params.jogoId);
  if (!jogo) return res.status(404).json({ erro: "jogo não encontrado" });
  if (jogo.status === "scheduled") return res.status(403).json({ erro: "os palpites só aparecem depois que o jogo começa" });

  const linhas = Object.keys(g.membros).map((email) => {
    const u = req.db.users[email];
    const p = g.palpites[email] && g.palpites[email][req.params.jogoId];
    const pontosObj = p ? Pontuacao.pointsFor(p, jogo) : null;
    return {
      jogador: u ? u.nome : "?",
      foto: (u && u.foto) || null,
      palpite: p ? `${p.h} – ${p.a}` : null,
      pontos: pontosObj ? pontosObj.total : null,
    };
  });
  linhas.sort((a, b) => (b.pontos ?? -1) - (a.pontos ?? -1));
  res.json({ jogo: { home: jogo.home, away: jogo.away, hs: jogo.hs, as: jogo.as, status: jogo.status }, linhas });
});

/* últimos 5 jogos de um time (forma recente) — guarda em cache por 20 min pra não gastar
   muitas chamadas da API só porque várias pessoas abriram o mesmo jogo pra ver */
const formaCache = {}; // teamId -> { atualizadoEm, jogos }
const FORMA_CACHE_MS = 20 * 60 * 1000;

async function buscarUltimosJogosTime(teamId) {
  const cache = formaCache[teamId];
  if (cache && Date.now() - cache.atualizadoEm < FORMA_CACHE_MS) return cache.jogos;
  if (!API_KEY) throw new Error("FOOTBALL_DATA_API_KEY não configurada");
  const url = `https://api.football-data.org/v4/teams/${teamId}/matches?status=FINISHED&limit=5`;
  const resp = await fetchFootballData(url);
  if (!resp.ok) throw new Error(`times respondeu ${resp.status}`);
  const data = await resp.json();
  const jogos = (data.matches || []).slice(-5).reverse().map((m) => {
    const casaId = m.homeTeam?.id;
    const mandante = casaId === teamId;
    const golsTime = mandante ? m.score?.fullTime?.home : m.score?.fullTime?.away;
    const golsAdversario = mandante ? m.score?.fullTime?.away : m.score?.fullTime?.home;
    let resultado = "E";
    if (golsTime > golsAdversario) resultado = "V";
    else if (golsTime < golsAdversario) resultado = "D";
    const adversario = mandante ? (m.awayTeam?.shortName || m.awayTeam?.name) : (m.homeTeam?.shortName || m.homeTeam?.name);
    return { data: m.utcDate, adversario, mandante, golsTime, golsAdversario, resultado };
  });
  formaCache[teamId] = { atualizadoEm: Date.now(), jogos };
  return jogos;
}

app.get("/api/times/:id/ultimos", autenticar, async (req, res) => {
  try {
    const jogos = await buscarUltimosJogosTime(Number(req.params.id));
    res.json({ jogos });
  } catch (e) {
    res.status(502).json({ erro: "não consegui buscar o histórico desse time agora" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Bolão rodando em http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn("⚠️  FOOTBALL_DATA_API_KEY não definida — os placares não vão atualizar. Veja o README.");
  }
  iniciarPush().catch((e) => console.error("push:", e.message)).finally(() => {
    pollAll();
    setInterval(pollAll, POLL_INTERVAL_MS);
    setInterval(tickAoVivo, AOVIVO_INTERVAL_MS);
  });
  pollStandings();
  setInterval(pollStandings, 10 * 60 * 1000); // tabela muda pouco, atualiza a cada 10 min

  // O plano grátis do Render "dorme" depois de ~15 min sem ninguém acessando — e servidor dormindo
  // não vê gol nenhum, ou seja, não manda notificação. Esse ping de tempos em tempos (na própria URL
  // pública, que o Render informa em RENDER_EXTERNAL_URL) mantém o servidor acordado. Pra desligar: MANTER_ACORDADO=0
  const urlPublica = process.env.RENDER_EXTERNAL_URL;
  if (urlPublica && process.env.MANTER_ACORDADO !== "0") {
    setInterval(() => { fetch(`${urlPublica}/health`).catch(() => {}); }, 10 * 60 * 1000);
  }
});
