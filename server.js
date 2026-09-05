/* Bolão de futebol — backend
   Consulta a API real da football-data.org periodicamente (sem precisar de clique)
   e guarda contas/grupos/palpites/histórico no Upstash (produção) ou arquivo local (dev) */

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Pontuacao = require("./public/scoring.js");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY || "";
const DB_PATH = path.join(__dirname, "data", "db.json");
const DB_KEY = "bolao_db";
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const POLL_INTERVAL_MS = 50 * 1000; // o mais rápido que dá pra ir com 7 ligas sem estourar os 10 req/min do plano grátis

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

async function buscarLiga(ligaId) {
  const meta = LEAGUE_META[ligaId];
  if (!API_KEY) throw new Error("FOOTBALL_DATA_API_KEY não configurada");
  const hoje = new Date();
  const de = new Date(hoje); de.setDate(de.getDate() - 200); // tentando de novo com mais cuidado — as quebras anteriores podem ter sido falha de build/upload, não da API
  const ate = new Date(hoje); ate.setDate(ate.getDate() + 21); // janela larga: garante que a próxima rodada já apareça assim que a atual acabar
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://api.football-data.org/v4/competitions/${meta.code}/matches?dateFrom=${fmt(de)}&dateTo=${fmt(ate)}`;
  const resp = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
  if (!resp.ok) throw new Error(`football-data respondeu ${resp.status}`);
  const data = await resp.json();
  const jogos = (data.matches || []).map((m) => ({
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
  }));
  jogos.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  return jogos;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollAll() {
  for (const ligaId of LEAGUE_IDS) {
    try {
      const jogos = await buscarLiga(ligaId);
      scoresCache[ligaId] = { atualizadoEm: Date.now(), jogos };
      for (const j of jogos) {
        if (j.status === "final") arquivoFinalizados[ligaId][j.id] = j;
      }
      await atualizarHistoricoDosGrupos(ligaId, jogos);
    } catch (e) {
      console.error(`erro ao buscar ${ligaId}:`, e.message);
    }
    await delay(1500); // espaça as chamadas pra não estourar o limite da API
  }
}

/* ---------------- tabela do campeonato (pra estimar probabilidade de vitória) ---------------- */

const standingsCache = Object.fromEntries(LEAGUE_IDS.map((id) => [id, {}])); // ligaId -> { [teamId]: {pontos, jogos, saldoGols} }

async function buscarTabela(ligaId) {
  const meta = LEAGUE_META[ligaId];
  if (!API_KEY) throw new Error("FOOTBALL_DATA_API_KEY não configurada");
  const url = `https://api.football-data.org/v4/competitions/${meta.code}/standings`;
  const resp = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
  if (!resp.ok) throw new Error(`standings respondeu ${resp.status}`);
  const data = await resp.json();
  const grupo = (data.standings || []).find((s) => s.type === "TOTAL") || (data.standings || [])[0];
  const tabela = {};
  for (const linha of (grupo?.table || [])) {
    if (linha.team?.id) {
      tabela[linha.team.id] = { pontos: linha.points, jogos: linha.playedGames, saldoGols: linha.goalDifference };
    }
  }
  return tabela;
}

async function pollStandings() {
  for (const ligaId of LEAGUE_IDS) {
    try {
      standingsCache[ligaId] = await buscarTabela(ligaId);
    } catch (e) {
      console.error(`erro ao buscar tabela ${ligaId}:`, e.message);
    }
    await delay(1500);
  }
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
async function atualizarHistoricoDosGrupos(ligaId, jogos) {
  const finalizados = jogos.filter((j) => j.status === "final").sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const jogosEncerrados = finalizados.length;
  const ultimoJogo = finalizados.length > 0 ? finalizados[finalizados.length - 1] : null;
  const db = await loadDb();
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
  if (mudou) await saveDb(db);
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
  await saveDb(db);
  res.json({ ok: true });
});

app.get("/api/grupos/:code/palpites", autenticar, (req, res) => {
  const g = req.db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
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
  res.json({ historico: g.historico || [], meuId: idAnonimo(req.userEmail) });
});

/* mostra o palpite de cada pessoa do grupo num jogo específico — só depois que o jogo
   começa (senão daria pra copiar o palpite de alguém antes de decidir o seu) */
app.get("/api/grupos/:code/jogo/:jogoId/palpites", autenticar, (req, res) => {
  const g = req.db.groups[req.params.code];
  if (!g) return res.status(404).json({ erro: "grupo não encontrado" });
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
  const resp = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
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
  pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
  pollStandings();
  setInterval(pollStandings, 10 * 60 * 1000); // tabela muda pouco, atualiza a cada 10 min
});
