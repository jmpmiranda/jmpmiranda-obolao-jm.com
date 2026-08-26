/* Bolão — front-end (sem build, JS puro) */

const LEAGUE_IDS_ORDEM = ["epl", "laliga", "seriea", "bundesliga", "ligue1"];
let LIGAS = {}; // preenchido via /api/ligas

const state = {
  token: null,
  conta: null, // {email, nome, foto}
  grupo: null, // {code, nome, liga}
  meusGrupos: [], // vem do servidor: [{code, nome, liga}]
  view: "carregando", // carregando | conta | home | bolao
  contaTab: "entrar", // entrar | criar | recuperar
  homeTab: "criar",
  abaBolao: "jogos", // jogos | finalizados | classificacao | config
  erro: "",
  carregando: false,
  scores: { jogos: [], atualizadoEm: null, apiConfigurada: true },
  meusPalpites: {},
  classificacao: [],
  meuId: null,
  criarForm: { liga: "epl" },
  faqAberto: null,
  copiado: false,
  enviandoFoto: false,
  graficoAberto: null,
  graficoCache: {},
  statusPorJogo: {},
  melhorRodada: null,
  codigoRecuperacaoParaMostrar: null,
  copiadoCodigoRecuperacao: false,
  mensagemConta: "",
};

let pollTimer = null;

function api(caminho, opts) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return fetch(caminho, {
    method: (opts && opts.method) || "GET",
    headers,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => {
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      const erro = new Error(dados.erro || "erro na requisição");
      erro.status = r.status;
      throw erro;
    }
    return dados;
  });
}

function fmtKickoff(iso) {
  try {
    const d = new Date(iso);
    const s = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(d);
    return s.charAt(0).toUpperCase() + s.slice(1).replace(",", "");
  } catch { return iso; }
}

/* ---------------- ciclo de vida ---------------- */

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* tenta buscar a conta algumas vezes antes de desistir — o Render grátis "dorme"
   depois de um tempo sem acesso e pode levar até uns 50s pra acordar de novo;
   sem isso, essa demora parecia "sessão expirada" e derrubava o login à toa */
async function buscarContaComEspera(tentativas) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await api("/api/conta/eu");
    } catch (e) {
      if (e.status === 401) throw e; // sessão realmente inválida — não adianta insistir
      if (i === tentativas - 1) throw e;
      state.view = "reconectando";
      render();
      await delay(4000);
    }
  }
}

async function iniciar() {
  try {
    const ligas = await api("/api/ligas");
    LIGAS = Object.fromEntries(ligas.map((l) => [l.id, l]));
  } catch { /* tenta de novo depois */ }

  state.token = localStorage.getItem("bolao_token") || null;
  if (state.token) {
    try {
      const eu = await buscarContaComEspera(4);
      state.conta = eu;
      const g = await api("/api/conta/grupos");
      state.meusGrupos = g.grupos || [];
      const ultimoCode = localStorage.getItem("bolao_ultimo_grupo");
      const entrada = state.meusGrupos.find((x) => x.code === ultimoCode) || state.meusGrupos[0];
      if (entrada) {
        state.grupo = { code: entrada.code, nome: entrada.nome, liga: entrada.liga, souCriador: false };
        state.view = "bolao";
        render();
        entrarNoBolao();
        api(`/api/grupos/${entrada.code}`).then((g) => { state.grupo.souCriador = !!g.souCriador; render(); }).catch(() => {});
        return;
      }
      state.view = "home";
      render();
      return;
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem("bolao_token");
        state.token = null;
        state.view = "conta";
        render();
        return;
      }
      // erro de rede/servidor fora do ar — mantém o token salvo e deixa a pessoa tentar de novo,
      // em vez de forçar um novo login sem necessidade
      state.view = "erro-conexao";
      render();
      return;
    }
  }
  state.view = "conta";
  render();
}

window.tentarDeNovo = function () { state.view = "carregando"; render(); iniciar(); };

function pararPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function entrarNoBolao() {
  pararPolling();
  await atualizarDadosBolao();
  pollTimer = setInterval(atualizarDadosBolao, 20000);
}

async function atualizarDadosBolao() {
  if (!state.grupo) return;
  try {
    const [scores, meus, classi] = await Promise.all([
      api(`/api/scores/${state.grupo.liga}`),
      api(`/api/grupos/${state.grupo.code}/palpites`),
      api(`/api/grupos/${state.grupo.code}/classificacao`),
    ]);
    state.scores = scores;
    state.meusPalpites = meus.palpites || {};
    state.classificacao = classi.classificacao || [];
    state.meuId = classi.meuId || null;
    state.melhorRodada = classi.melhorRodada || null;
    verificarLembretes();
    if (state.graficoAberto) {
      try {
        const r = await api(`/api/grupos/${state.grupo.code}/historico`);
        state.graficoCache[state.graficoAberto] = r.historico || [];
      } catch { /* mantém cache */ }
    }
    render();
  } catch (e) { console.error(e); }
}

/* ---------------- conta ---------------- */

window.setContaTab = function (tab) { state.contaTab = tab; state.erro = ""; render(); };

window.criarConta = async function () {
  const email = document.getElementById("cc-email").value.trim();
  const senha = document.getElementById("cc-senha").value.trim();
  const nome = document.getElementById("cc-nome").value.trim();
  if (!email || !senha || !nome) { state.erro = "Preencha email, senha e apelido."; render(); return; }
  state.carregando = true; render();
  try {
    const r = await api("/api/conta/criar", { method: "POST", body: { email, senha, nome } });
    state.token = r.token;
    localStorage.setItem("bolao_token", r.token);
    state.conta = { email: r.email, nome: r.nome, foto: null };
    state.meusGrupos = [];
    state.erro = "";
    state.carregando = false;
    state.codigoRecuperacaoParaMostrar = r.codigoRecuperacao;
    state.view = "codigo-recuperacao";
    render();
  } catch (e) {
    state.erro = e.message;
    state.carregando = false;
    render();
  }
};

window.confirmarGuardouCodigo = function () {
  state.codigoRecuperacaoParaMostrar = null;
  state.view = "home";
  render();
};

window.copiarCodigoRecuperacao = async function () {
  try { await navigator.clipboard.writeText(state.codigoRecuperacaoParaMostrar); } catch {}
  state.copiadoCodigoRecuperacao = true; render();
  setTimeout(() => { state.copiadoCodigoRecuperacao = false; render(); }, 1500);
};

window.entrarConta = async function () {
  const email = document.getElementById("ec-email").value.trim();
  const senha = document.getElementById("ec-senha").value.trim();
  if (!email || !senha) { state.erro = "Preencha email e senha."; render(); return; }
  state.carregando = true; render();
  try {
    const r = await api("/api/conta/entrar", { method: "POST", body: { email, senha } });
    state.token = r.token;
    localStorage.setItem("bolao_token", r.token);
    state.conta = { email: r.email, nome: r.nome, foto: null };
    const g = await api("/api/conta/grupos");
    state.meusGrupos = g.grupos || [];
    state.erro = "";
    state.carregando = false;
    state.view = "home";
    render();
  } catch (e) {
    state.erro = e.message;
    state.carregando = false;
    render();
  }
};

window.recuperarSenha = async function () {
  const email = document.getElementById("rc-email").value.trim();
  const codigo = document.getElementById("rc-codigo").value.trim();
  const novaSenha = document.getElementById("rc-senha").value.trim();
  if (!email || !codigo || !novaSenha) { state.erro = "Preencha email, código e a nova senha."; render(); return; }
  state.carregando = true; render();
  try {
    await api("/api/conta/recuperar", { method: "POST", body: { email, codigoRecuperacao: codigo, novaSenha } });
    state.erro = "";
    state.carregando = false;
    state.contaTab = "entrar";
    state.mensagemConta = "Senha alterada! Já pode entrar com a senha nova.";
    render();
    setTimeout(() => { state.mensagemConta = ""; render(); }, 4000);
  } catch (e) {
    state.erro = e.message;
    state.carregando = false;
    render();
  }
};

window.sairDaConta = async function () {
  try { await api("/api/conta/sair", { method: "POST" }); } catch { /* segue mesmo assim */ }
  pararPolling();
  localStorage.removeItem("bolao_token");
  localStorage.removeItem("bolao_ultimo_grupo");
  state.token = null;
  state.conta = null;
  state.grupo = null;
  state.meusGrupos = [];
  state.view = "conta";
  render();
};

window.editarApelido = async function () {
  const novo = prompt("Novo apelido:", state.conta.nome);
  if (!novo || !novo.trim() || novo.trim() === state.conta.nome) return;
  try {
    await api("/api/conta/nome", { method: "POST", body: { nome: novo.trim() } });
    state.conta.nome = novo.trim();
    render();
  } catch (e) {
    alert("Não consegui trocar o apelido: " + e.message);
  }
};

/* ---------------- home / grupos ---------------- */

window.setHomeTab = function (tab) { state.homeTab = tab; state.erro = ""; render(); };
window.escolherLigaCriar = function (id) { state.criarForm.liga = id; render(); };

window.criarGrupo = async function () {
  const nome = document.getElementById("cg-nome").value.trim();
  const senha = document.getElementById("cg-senha").value.trim();
  const liga = state.criarForm.liga;
  if (!nome || !senha) { state.erro = "Preencha o nome do grupo e a senha."; render(); return; }
  state.carregando = true; render();
  try {
    const r = await api("/api/grupos", { method: "POST", body: { nome, senha, liga } });
    state.meusGrupos = [...state.meusGrupos.filter((g) => g.code !== r.code), { code: r.code, nome: r.nome, liga: r.liga }];
    localStorage.setItem("bolao_ultimo_grupo", r.code);
    state.grupo = { code: r.code, nome: r.nome, liga: r.liga, souCriador: !!r.souCriador };
    state.statusPorJogo = {};
    state.erro = "";
    state.view = "bolao";
    state.abaBolao = "jogos";
    state.carregando = false;
    render();
    entrarNoBolao();
  } catch (e) {
    state.erro = e.message;
    state.carregando = false;
    render();
  }
};

window.entrarGrupo = async function () {
  const codigo = document.getElementById("eg-codigo").value.trim().toUpperCase();
  const senha = document.getElementById("eg-senha").value.trim();
  if (!codigo) { state.erro = "Preencha o código do grupo."; render(); return; }
  state.carregando = true; render();
  try {
    const r = await api(`/api/grupos/${codigo}/entrar`, { method: "POST", body: { senha } });
    state.meusGrupos = [...state.meusGrupos.filter((g) => g.code !== r.code), { code: r.code, nome: r.nome, liga: r.liga }];
    localStorage.setItem("bolao_ultimo_grupo", r.code);
    state.grupo = { code: r.code, nome: r.nome, liga: r.liga, souCriador: !!r.souCriador };
    state.statusPorJogo = {};
    state.erro = "";
    state.view = "bolao";
    state.abaBolao = "jogos";
    state.carregando = false;
    render();
    entrarNoBolao();
  } catch (e) {
    state.erro = e.message;
    state.carregando = false;
    render();
  }
};

window.abrirGrupoLocal = async function (code) {
  const entry = state.meusGrupos.find((g) => g.code === code);
  if (!entry) return;
  localStorage.setItem("bolao_ultimo_grupo", code);
  state.grupo = { code: entry.code, nome: entry.nome, liga: entry.liga, souCriador: false };
  state.statusPorJogo = {};
  state.view = "bolao";
  state.abaBolao = "jogos";
  render();
  entrarNoBolao();
  try {
    const g = await api(`/api/grupos/${code}`);
    state.grupo.souCriador = !!g.souCriador;
    render();
  } catch { /* segue sem essa info, não é crítico */ }
};

window.setAbaBolao = function (aba) { state.abaBolao = aba; render(); };

window.trocarDeGrupo = function () {
  pararPolling();
  state.grupo = null;
  state.classificacao = [];
  state.scores = { jogos: [], atualizadoEm: null };
  state.statusPorJogo = {};
  state.view = "home";
  render();
};

window.sairDoGrupo = async function () {
  if (!confirm(`Tem certeza que quer sair de "${state.grupo.nome}"? Seus palpites nesse grupo vão ser apagados.`)) return;
  try {
    await api(`/api/grupos/${state.grupo.code}/sair`, { method: "POST" });
    state.meusGrupos = state.meusGrupos.filter((g) => g.code !== state.grupo.code);
    if (localStorage.getItem("bolao_ultimo_grupo") === state.grupo.code) localStorage.removeItem("bolao_ultimo_grupo");
    trocarDeGrupo();
  } catch (e) {
    alert("Não consegui sair do grupo agora: " + e.message);
  }
};

window.trocarSenhaGrupo = async function () {
  const novaSenha = prompt("Nova senha do grupo (quem tiver a senha antiga não entra mais, só a nova):");
  if (!novaSenha) return;
  try {
    await api(`/api/grupos/${state.grupo.code}/trocar-senha`, { method: "POST", body: { novaSenha } });
    alert("Senha do grupo atualizada!");
  } catch (e) {
    alert("Não consegui trocar a senha: " + e.message);
  }
};

window.copiarCodigo = async function () {
  try { await navigator.clipboard.writeText(state.grupo.code); } catch {}
  state.copiado = true; render();
  setTimeout(() => { state.copiado = false; render(); }, 1500);
};

/* ---------------- palpites ---------------- */

window.ajustarPalpite = function (jogoId, lado, delta) {
  const atual = state.meusPalpites[jogoId] || { h: 0, a: 0 };
  const novo = { ...atual, [lado]: Math.max(0, Math.min(9, (atual[lado] || 0) + delta)) };
  state.meusPalpites = { ...state.meusPalpites, [jogoId]: novo };
  agendarSalvarPalpites(jogoId);
};

/* ---------------- sincronizar palpites entre grupos da mesma liga ---------------- */

function carregarSync() {
  try { return JSON.parse(localStorage.getItem("bolao_sync_grupos") || "[]"); } catch { return []; }
}
function salvarSync(lista) {
  localStorage.setItem("bolao_sync_grupos", JSON.stringify(lista));
}
window.toggleSyncGrupo = function (code) {
  let lista = carregarSync();
  lista = lista.includes(code) ? lista.filter((c) => c !== code) : [...lista, code];
  salvarSync(lista);
  render();
};

/* salva sozinho ~700ms depois do último toque nos +/- , sem precisar de botão —
   dá tempo da pessoa terminar de ajustar os dois placares antes de mandar pro servidor.
   o status de "salvando/salvo" aparece dentro do bloquinho do jogo específico que foi mexido */
let salvarTimer = null;
let jogosPendentes = new Set();

function agendarSalvarPalpites(jogoId) {
  jogosPendentes.add(jogoId);
  state.statusPorJogo[jogoId] = "salvando";
  render();
  if (salvarTimer) clearTimeout(salvarTimer);
  salvarTimer = setTimeout(salvarPalpitesAgora, 700);
}

async function salvarPalpitesAgora() {
  const pendentesDessaVez = Array.from(jogosPendentes);
  jogosPendentes = new Set();
  try {
    await api(`/api/grupos/${state.grupo.code}/palpites`, { method: "POST", body: { palpites: state.meusPalpites } });

    // copia os mesmos palpites pros grupos marcados como sincronizados (só faz sentido entre grupos da mesma liga)
    const sincronizados = carregarSync().filter((code) => {
      if (code === state.grupo.code) return false;
      const g = state.meusGrupos.find((x) => x.code === code);
      return g && g.liga === state.grupo.liga;
    });
    for (const code of sincronizados) {
      try { await api(`/api/grupos/${code}/palpites`, { method: "POST", body: { palpites: state.meusPalpites } }); } catch { /* segue tentando os outros */ }
    }

    for (const id of pendentesDessaVez) state.statusPorJogo[id] = sincronizados.length > 0 ? "sincronizado" : "salvo";
    render();
    const classi = await api(`/api/grupos/${state.grupo.code}/classificacao`);
    state.classificacao = classi.classificacao || [];
    state.melhorRodada = classi.melhorRodada || null;
    render();
    setTimeout(() => {
      for (const id of pendentesDessaVez) if (state.statusPorJogo[id] === "salvo" || state.statusPorJogo[id] === "sincronizado") delete state.statusPorJogo[id];
      render();
    }, 2200);
  } catch (e) {
    for (const id of pendentesDessaVez) state.statusPorJogo[id] = "erro";
    render();
  }
}

/* ---------------- foto de perfil (agora é da conta, vale em todo grupo) ---------------- */

function redimensionarImagem(file) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const alvo = 200;
        const canvas = document.createElement("canvas");
        canvas.width = alvo; canvas.height = alvo;
        const ctx = canvas.getContext("2d");
        const escala = Math.max(alvo / img.width, alvo / img.height);
        const w = img.width * escala, h = img.height * escala;
        ctx.drawImage(img, (alvo - w) / 2, (alvo - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("não consegui ler essa imagem"));
      img.src = e.target.result;
    };
    leitor.onerror = () => reject(new Error("não consegui ler esse arquivo"));
    leitor.readAsDataURL(file);
  });
}

window.selecionarFoto = function () {
  const input = document.getElementById("input-foto");
  if (input) input.click();
};

window.onFotoSelecionada = async function (input) {
  const file = input.files && input.files[0];
  if (!file) return;
  state.enviandoFoto = true; render();
  try {
    const dataUrl = await redimensionarImagem(file);
    await api("/api/conta/foto", { method: "POST", body: { foto: dataUrl } });
    state.conta.foto = dataUrl;
    state.enviandoFoto = false;
    render();
    if (state.grupo) atualizarDadosBolao();
  } catch (e) {
    state.enviandoFoto = false;
    render();
    alert("Não deu pra usar essa foto (" + e.message + "). Tenta outra.");
  }
};

/* ---------------- lembrete de palpite (notificação do navegador) ---------------- */

function statusNotificacao() {
  if (!("Notification" in window)) return "sem-suporte";
  return Notification.permission;
}

window.ativarLembretes = async function () {
  if (!("Notification" in window)) { alert("Esse navegador não suporta notificações."); return; }
  await Notification.requestPermission();
  render();
};

function verificarLembretes() {
  if (statusNotificacao() !== "granted" || !state.grupo) return;
  let enviados = [];
  try { enviados = JSON.parse(localStorage.getItem("bolao_lembretes_enviados") || "[]"); } catch {}
  const agora = Date.now();
  let mudou = false;
  for (const g of state.scores.jogos) {
    if (g.status !== "scheduled") continue;
    const faltam = new Date(g.kickoff).getTime() - agora;
    const chave = `${state.grupo.code}:${g.id}`;
    const jaPalpitou = !!state.meusPalpites[g.id];
    if (faltam > 0 && faltam <= 60 * 60 * 1000 && !jaPalpitou && !enviados.includes(chave)) {
      try {
        const notif = new Notification("⏰ Falta 1h pro jogo!", {
          body: `${g.home} x ${g.away} começa em breve e você ainda não deu seu palpite no ${state.grupo.nome}.`,
        });
        notif.onclick = () => { window.focus(); };
      } catch { /* navegador pode bloquear silenciosamente */ }
      enviados.push(chave);
      mudou = true;
    }
  }
  if (mudou) {
    if (enviados.length > 200) enviados = enviados.slice(-200);
    localStorage.setItem("bolao_lembretes_enviados", JSON.stringify(enviados));
  }
}

/* ---------------- gráfico de posição no ranking ---------------- */

window.toggleGrafico = async function (slug) {
  if (state.graficoAberto === slug) { state.graficoAberto = null; render(); return; }
  state.graficoAberto = slug;
  render();
  if (!state.graficoCache[slug]) {
    try {
      const r = await api(`/api/grupos/${state.grupo.code}/historico`);
      state.graficoCache[slug] = r.historico || [];
    } catch { state.graficoCache[slug] = []; }
    render();
  }
};

function montarGraficoInline(historico, slug) {
  const pontos = (historico || [])
    .map((h) => {
      const l = h.linhas.find((x) => x.slug === slug);
      return l ? { x: h.jogosEncerrados, y: l.colocacao, total: l.total } : null;
    })
    .filter(Boolean);

  if (pontos.length < 2) {
    return `<div style="padding:22px 18px;text-align:center">
      <p class="f-mono" style="color:var(--paper-soft);font-size:13px;margin:0">
        Ainda não há histórico suficiente pra desenhar o gráfico — ele vai se formando conforme os jogos da temporada vão terminando.
      </p></div>`;
  }

  const maxRank = Math.max(...pontos.map((p) => p.y), 1);
  const W = 720, H = 360, PAD = 46;
  const minX = Math.min(...pontos.map((p) => p.x));
  const maxX = Math.max(...pontos.map((p) => p.x));
  const sx = (x) => (maxX === minX ? W / 2 : PAD + ((x - minX) / (maxX - minX)) * (W - 2 * PAD));
  const sy = (y) => PAD + ((y - 1) / Math.max(maxRank - 1, 1)) * (H - 2 * PAD);

  const path = pontos.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const circles = pontos.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="6" fill="#FFB100" />`).join("");
  const xLabels = pontos.map((p) => `<text x="${sx(p.x).toFixed(1)}" y="${H - 14}" font-size="13" text-anchor="middle" fill="#EFE7D0">${p.x}</text>`).join("");
  let yLabels = "";
  for (let r = 1; r <= maxRank; r++) yLabels += `<text x="10" y="${(sy(r) + 4).toFixed(1)}" font-size="13" fill="#EFE7D0">${r}º</text>`;

  const primeira = pontos[0].y, ultima = pontos[pontos.length - 1].y;
  const diff = primeira - ultima;
  let resumo;
  if (diff > 0) resumo = `⬆ subiu ${diff} posição${diff > 1 ? "ões" : ""} desde o início da temporada`;
  else if (diff < 0) resumo = `⬇ caiu ${Math.abs(diff)} posição${Math.abs(diff) > 1 ? "ões" : ""} desde o início da temporada`;
  else resumo = "➡ manteve a posição desde o início da temporada";

  return `<div style="padding:16px 18px 20px;background:rgba(0,0,0,0.15);border-radius:10px;margin:4px 0 10px">
    <p class="f-mono" style="color:var(--paper-soft);font-size:12px;margin:0 0 10px">colocação ao longo dos jogos encerrados na temporada</p>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      <line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="rgba(251,248,239,0.25)" />
      <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="rgba(251,248,239,0.25)" />
      ${yLabels}${xLabels}
      <path d="${path}" fill="none" stroke="#FFB100" stroke-width="3.5" />
      ${circles}
    </svg>
    <p class="f-mono" style="color:var(--white);font-size:14px;font-weight:600;margin-top:14px">${resumo}</p>
    <p class="f-mono" style="color:var(--paper-soft);font-size:11px;margin-top:2px;opacity:.8">eixo X: nº de jogos já encerrados na temporada · eixo Y: colocação no grupo (1º no topo)</p>
  </div>`;
}

/* ---------------- avatar ---------------- */

function iniciais(nome) { return (nome || "?").trim().charAt(0).toUpperCase(); }

function avatarHtml(nome, foto, tamanho) {
  tamanho = tamanho || 34;
  if (foto) {
    return `<img src="${foto}" style="width:${tamanho}px;height:${tamanho}px;border-radius:50%;object-fit:cover;border:2px solid var(--paper);display:block;flex-shrink:0" />`;
  }
  return `<div style="width:${tamanho}px;height:${tamanho}px;border-radius:50%;background:var(--pitch);color:var(--amber);display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-weight:700;font-size:${Math.round(tamanho * 0.45)}px;flex-shrink:0">${iniciais(nome)}</div>`;
}

function escudoHtml(url, alt, tamanho) {
  tamanho = tamanho || 28;
  if (url) {
    return `<img src="${url}" alt="${alt}" style="width:${tamanho}px;height:${tamanho}px;object-fit:contain;display:block;margin:0 auto 4px" onerror="this.style.display='none'" />`;
  }
  return `<div style="width:${tamanho}px;height:${tamanho}px;margin:0 auto 4px"></div>`;
}

/* ---------------- telas ---------------- */

function telaConta() {
  const erroHtml = state.erro ? `<p class="f-mono" style="color:var(--live);font-size:12px">${state.erro}</p>` : "";
  return `
    <div class="pitch-stripes" style="min-height:100vh;padding:32px 20px">
      <div style="max-width:380px;margin:0 auto">
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:26px">🎟️</div>
          <h1 class="f-display" style="text-transform:uppercase;font-weight:700;font-size:30px;margin:4px 0 0;color:var(--white)">Bolão</h1>
          <p class="f-mono" style="color:var(--paper-soft);font-size:12px;margin-top:4px">crie uma conta pra jogar em qualquer aparelho</p>
        </div>

        <div class="tabbar" style="margin-bottom:14px">
          <button class="${state.contaTab === "entrar" ? "ativo" : ""}" onclick="setContaTab('entrar')">Entrar</button>
          <button class="${state.contaTab === "criar" ? "ativo" : ""}" onclick="setContaTab('criar')">Criar conta</button>
        </div>

        ${state.mensagemConta ? `<p class="f-mono" style="color:var(--amber);font-size:12px;text-align:center;margin-bottom:10px">${state.mensagemConta}</p>` : ""}

        <div class="card-panel">
          ${state.contaTab === "entrar" ? `
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Email</label>
            <input id="ec-email" type="email" class="input-field" placeholder="voce@email.com" style="margin:6px 0 12px" />
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Senha</label>
            <input id="ec-senha" type="password" class="input-field" style="margin:6px 0 12px" placeholder="Sua senha" onkeydown="if(event.key==='Enter')entrarConta()" />
            ${erroHtml}
            <button class="chip btn-amber f-display" style="width:100%;text-transform:uppercase;margin-top:4px" onclick="entrarConta()" ${state.carregando ? "disabled" : ""}>${state.carregando ? "Entrando…" : "Entrar"}</button>
            <button class="f-mono" style="display:block;margin:12px auto 0;background:none;color:var(--ink-soft);text-decoration:underline;font-size:11px" onclick="setContaTab('recuperar')">esqueci minha senha</button>
          ` : state.contaTab === "criar" ? `
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Seu apelido</label>
            <input id="cc-nome" class="input-field" placeholder="Como querem te chamar" style="margin:6px 0 12px" />
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Email</label>
            <input id="cc-email" type="email" class="input-field" placeholder="voce@email.com" style="margin:6px 0 12px" />
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Senha</label>
            <input id="cc-senha" type="password" class="input-field" style="margin:6px 0 12px" placeholder="Pelo menos 6 caracteres" onkeydown="if(event.key==='Enter')criarConta()" />
            ${erroHtml}
            <button class="chip btn-amber f-display" style="width:100%;text-transform:uppercase;margin-top:4px" onclick="criarConta()" ${state.carregando ? "disabled" : ""}>${state.carregando ? "Criando…" : "Criar conta"}</button>
          ` : `
            <p class="f-mono" style="font-size:12px;color:var(--ink-soft);margin:0 0 12px">Só funciona se você guardou o código de recuperação mostrado quando criou a conta.</p>
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Email</label>
            <input id="rc-email" type="email" class="input-field" placeholder="voce@email.com" style="margin:6px 0 12px" />
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Código de recuperação</label>
            <input id="rc-codigo" class="input-field code-plate" style="text-align:center;margin:6px 0 12px" placeholder="Ex: X7K2QPM4RT89" />
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Nova senha</label>
            <input id="rc-senha" type="password" class="input-field" style="margin:6px 0 12px" placeholder="Pelo menos 6 caracteres" onkeydown="if(event.key==='Enter')recuperarSenha()" />
            ${erroHtml}
            <button class="chip btn-amber f-display" style="width:100%;text-transform:uppercase;margin-top:4px" onclick="recuperarSenha()" ${state.carregando ? "disabled" : ""}>${state.carregando ? "Trocando…" : "Trocar senha"}</button>
            <button class="f-mono" style="display:block;margin:12px auto 0;background:none;color:var(--ink-soft);text-decoration:underline;font-size:11px" onclick="setContaTab('entrar')">voltar</button>
          `}
        </div>
        <p class="f-mono" style="font-size:11px;color:var(--paper-soft);text-align:center;margin-top:14px;opacity:.8">com uma conta, você entra nos mesmos grupos de qualquer celular ou computador</p>
      </div>
    </div>`;
}

function telaCodigoRecuperacao() {
  return `
    <div class="pitch-stripes center-screen">
      <div class="card-panel" style="max-width:380px;width:100%;text-align:center">
        <div style="font-size:30px;margin-bottom:6px">🔑</div>
        <h1 class="f-display" style="text-transform:uppercase;font-weight:700;font-size:22px;margin:0;color:var(--ink)">Guarde seu código de recuperação</h1>
        <p class="f-mono" style="color:var(--ink-soft);font-size:12px;margin:10px 0 16px">É a única forma de trocar sua senha se você esquecer. Não tem como recuperar de outro jeito — tira um print ou anota em algum lugar seguro agora.</p>
        <div class="chip code-plate" style="background:var(--paper-soft);border-radius:10px;padding:16px;font-size:18px;color:var(--ink);word-break:break-all;margin-bottom:12px" onclick="copiarCodigoRecuperacao()">
          ${state.codigoRecuperacaoParaMostrar} ${state.copiadoCodigoRecuperacao ? "✓" : "📋"}
        </div>
        <button class="chip btn-amber f-display" style="width:100%;text-transform:uppercase" onclick="confirmarGuardouCodigo()">Já guardei, continuar</button>
      </div>
    </div>`;
}

function chipsLigas(ligaAtiva, onClickFn) {
  return LEAGUE_IDS_ORDEM.map((id) => {
    const l = LIGAS[id] || {};
    const ativo = id === ligaAtiva;
    return `<button class="chip f-display" style="border-radius:999px;padding:7px 12px;font-size:12px;font-weight:600;background:${ativo ? "var(--pitch)" : "var(--paper-soft)"};color:${ativo ? "var(--white)" : "var(--ink)"}" onclick="${onClickFn}('${id}')">${l.flag || ""} ${l.name || id}</button>`;
  }).join("");
}

function telaHome() {
  const erroHtml = state.erro ? `<p class="f-mono" style="color:var(--live);font-size:12px">${state.erro}</p>` : "";
  return `
    <div class="pitch-stripes" style="min-height:100vh;padding:32px 20px">
      <div style="max-width:380px;margin:0 auto">
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:26px">🏆</div>
          <h1 class="f-display" style="text-transform:uppercase;font-weight:700;font-size:30px;margin:4px 0 0;color:var(--white)">Bolão</h1>
          <p class="f-mono" style="color:var(--paper-soft);font-size:12px;margin-top:4px">e aí, <b style="color:var(--amber)">${state.conta.nome}</b> — crie ou entre num grupo</p>
        </div>

        ${state.meusGrupos.length > 0 ? `
          <div class="card-panel" style="margin-bottom:14px">
            <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:0 0 10px">SEUS GRUPOS</p>
            ${state.meusGrupos.map((g) => `
              <div class="chip" onclick="abrirGrupoLocal('${g.code}')" style="display:flex;align-items:center;justify-content:space-between;padding:10px 4px;border-bottom:1px solid rgba(28,27,20,0.1)">
                <div style="min-width:0">
                  <div class="f-display" style="font-size:14px;color:var(--ink)">${LIGAS[g.liga]?.flag || ""} ${g.nome}</div>
                  <div class="f-mono" style="font-size:11px;color:var(--ink-soft)">código ${g.code}</div>
                </div>
              </div>`).join("")}
          </div>
          <p class="f-mono" style="font-size:11px;color:var(--paper-soft);margin:-6px 0 14px;text-align:center">ou entre em mais um grupo abaixo</p>
        ` : ""}

        <div class="tabbar" style="margin-bottom:14px">
          <button class="${state.homeTab === "criar" ? "ativo" : ""}" onclick="setHomeTab('criar')">Criar grupo</button>
          <button class="${state.homeTab === "entrar" ? "ativo" : ""}" onclick="setHomeTab('entrar')">Entrar com código</button>
        </div>

        <div class="card-panel">
          ${state.homeTab === "criar" ? `
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Nome do grupo</label>
            <input id="cg-nome" class="input-field" placeholder="Ex: Bolão do trampo" style="margin:6px 0 12px" />
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Senha do grupo</label>
            <input id="cg-senha" type="password" class="input-field" placeholder="Só quem tem a senha entra" style="margin:6px 0 12px" />
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft);display:block;margin-bottom:8px">Escolha a liga do grupo</label>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">${chipsLigas(state.criarForm.liga, "escolherLigaCriar")}</div>
            ${erroHtml}
            <button class="chip btn-amber f-display" style="width:100%;text-transform:uppercase" onclick="criarGrupo()" ${state.carregando ? "disabled" : ""}>${state.carregando ? "Criando…" : "Criar grupo"}</button>
          ` : `
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Código do grupo</label>
            <input id="eg-codigo" class="input-field code-plate" style="text-align:center;margin:6px 0 12px" maxlength="8" placeholder="Ex: X7K2QP" />
            <label class="f-mono" style="font-size:12px;color:var(--ink-soft)">Senha</label>
            <input id="eg-senha" type="password" class="input-field" style="margin:6px 0 12px" placeholder="Senha do grupo" onkeydown="if(event.key==='Enter')entrarGrupo()" />
            ${erroHtml}
            <button class="chip btn-amber f-display" style="width:100%;text-transform:uppercase" onclick="entrarGrupo()" ${state.carregando ? "disabled" : ""}>${state.carregando ? "Entrando…" : "Entrar no grupo"}</button>
          `}
        </div>

        <button class="f-mono" style="display:block;margin:16px auto 0;background:none;color:var(--paper-soft);text-decoration:underline;font-size:12px" onclick="sairDaConta()">sair da conta</button>
      </div>
    </div>`;
}

function probabilidadeHtml(p, ha, aa) {
  if (!p) return "";
  return `
    <div style="margin:10px 0 2px">
      <div style="display:flex;height:6px;border-radius:4px;overflow:hidden">
        <div style="width:${p.casa}%;background:var(--pitch)"></div>
        <div style="width:${p.empate}%;background:var(--gold)"></div>
        <div style="width:${p.fora}%;background:var(--amber)"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:3px">
        <span class="f-mono" style="font-size:10px;color:var(--ink-soft)">${ha} ${p.casa}%</span>
        <span class="f-mono" style="font-size:10px;color:var(--ink-soft)">empate ${p.empate}%</span>
        <span class="f-mono" style="font-size:10px;color:var(--ink-soft)">${aa} ${p.fora}%</span>
      </div>
    </div>`;
}

function statusJogoHtml(jogoId) {
  const s = state.statusPorJogo[jogoId];
  if (s === "salvando") return `<span class="f-mono" style="font-size:10px;color:var(--ink-soft)">💾 salvando…</span>`;
  if (s === "salvo") return `<span class="f-mono" style="font-size:10px;color:var(--pitch)">✓ salvo</span>`;
  if (s === "sincronizado") return `<span class="f-mono" style="font-size:10px;color:var(--pitch)">✓ salvo e sincronizado</span>`;
  if (s === "erro") return `<span class="f-mono" style="font-size:10px;color:var(--live)">não salvou — mexe de novo</span>`;
  return "";
}

function cartaoJogo(g) {
  const bloqueado = g.status !== "scheduled";
  const pick = state.meusPalpites[g.id] || { h: 0, a: 0 };
  const pts = window.Pontuacao.pointsFor(state.meusPalpites[g.id], g);
  let statusHtml;
  if (g.status === "live") {
    const tempo = g.minuto != null ? `${g.minuto}${g.acrescimo ? "+" + g.acrescimo : ""}'` : null;
    statusHtml = `<span class="f-display" style="color:var(--live);font-weight:700;font-size:12px;display:flex;align-items:center;gap:5px"><span class="live-dot"></span>AO VIVO${tempo ? ` · ${tempo}` : ""}</span>`;
  }
  else if (g.status === "final") statusHtml = `<span class="f-mono" style="color:var(--ink-soft);font-size:12px">✓ encerrado</span>`;
  else if (g.status === "adiado") statusHtml = `<span class="f-mono" style="color:var(--live);font-size:12px">adiado</span>`;
  else statusHtml = `<span class="f-mono" style="color:var(--gold);font-size:12px">a começar</span>`;

  return `
    <div class="ticket">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px">
        <span class="f-mono" style="color:var(--ink-soft);font-size:11px">${fmtKickoff(g.kickoff)}</span>
        ${statusHtml}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="flex:1;min-width:0;text-align:center">
          ${escudoHtml(g.haEscudo, g.ha, 30)}
          <div class="f-display" style="font-size:13px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${g.home}</div>
          <div class="f-mono" style="font-size:11px;color:var(--ink-soft)">${g.ha}</div>
        </div>
        <div class="f-score" style="font-size:34px;color:var(--ink);padding:0 8px">${bloqueado ? `${g.hs} – ${g.as}` : "vs"}</div>
        <div style="flex:1;min-width:0;text-align:center">
          ${escudoHtml(g.aaEscudo, g.aa, 30)}
          <div class="f-display" style="font-size:13px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${g.away}</div>
          <div class="f-mono" style="font-size:11px;color:var(--ink-soft)">${g.aa}</div>
        </div>
      </div>
      ${!bloqueado ? probabilidadeHtml(g.probabilidade, g.ha, g.aa) : ""}
      <div style="margin-top:10px;padding-top:10px;border-top:1px dashed rgba(28,27,20,0.18)">
        <div style="display:flex;justify-content:space-between;margin-bottom:2px">
          <span class="f-mono" style="font-size:11px;color:var(--ink-soft)">seu palpite</span>
          ${bloqueado && pts ? `<span class="badge" style="background:${pts.total > 0 ? "var(--amber)" : "transparent"};color:var(--ink)">${pts.total > 0 ? `+${pts.total} pts` : "sem pontos"}</span>` : ""}
          ${!bloqueado ? statusJogoHtml(g.id) : ""}
        </div>
        ${bloqueado && pts && pts.tags.length ? `<div class="f-mono" style="font-size:11px;color:var(--ink-soft);margin-bottom:4px">${pts.tags.join(" · ")}</div>` : ""}
        ${bloqueado
          ? `<div class="f-score" style="text-align:center;font-size:22px;color:var(--ink-soft);margin-top:4px">🔒 ${state.meusPalpites[g.id]?.h ?? "–"} – ${state.meusPalpites[g.id]?.a ?? "–"}</div>`
          : `<div class="stepper" style="margin-top:4px">
              <button onclick="ajustarPalpite('${g.id}','h',-1)">−</button><span>${pick.h}</span><button onclick="ajustarPalpite('${g.id}','h',1)">+</button>
              <span class="f-score" style="font-size:20px;color:var(--ink-soft)">×</span>
              <button onclick="ajustarPalpite('${g.id}','a',-1)">−</button><span>${pick.a}</span><button onclick="ajustarPalpite('${g.id}','a',1)">+</button>
            </div>`}
      </div>
    </div>`;
}

function abaJogos() {
  const liga = LIGAS[state.grupo.liga] || {};
  const proximos = state.scores.jogos.filter((g) => g.status !== "final");
  const avisoApi = state.scores.apiConfigurada === false
    ? `<div class="ticket" style="border-style:solid;border-color:var(--live)"><p class="f-mono" style="color:var(--live);font-size:12px;margin:0">O servidor ainda não tem a chave da API configurada (FOOTBALL_DATA_API_KEY) — veja o README.</p></div>`
    : "";
  return `
    <div class="wrap" style="padding:18px 20px 30px">
      <h2 class="f-display" style="text-transform:uppercase;font-size:22px;color:var(--ink);margin:0">${liga.flag || ""} ${liga.name || ""}</h2>
      <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:2px 0 4px">
        ${liga.country || ""} · ${proximos.length} jogo(s) a acontecer/em andamento ·
        ${state.scores.atualizadoEm ? `atualizado às ${new Date(state.scores.atualizadoEm).toLocaleTimeString("pt-BR")}` : "aguardando primeira atualização"}
      </p>
      <p class="f-mono" style="font-size:10px;color:var(--ink-soft);margin:0 0 14px;opacity:.75">seus palpites são salvos sozinhos, um por um, e podem ser trocados até o jogo começar · a barrinha de % é uma estimativa baseada na tabela do campeonato, não é odds de casa de apostas</p>
      ${avisoApi}
      ${proximos.length === 0
        ? `<p class="f-mono" style="color:var(--ink-soft);font-size:13px">Todos os jogos dessa rodada já terminaram — dá uma olhada na aba <b>Finalizados</b>.</p>`
        : `<div style="display:grid;gap:10px">${proximos.map(cartaoJogo).join("")}</div>`}
    </div>`;
}

function abaFinalizados() {
  const liga = LIGAS[state.grupo.liga] || {};
  const finalizados = state.scores.jogos.filter((g) => g.status === "final").sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));
  let meusPontos = 0;
  for (const g of finalizados) {
    const p = window.Pontuacao.pointsFor(state.meusPalpites[g.id], g);
    if (p) meusPontos += p.total;
  }
  return `
    <div class="wrap" style="padding:18px 20px 30px">
      <h2 class="f-display" style="text-transform:uppercase;font-size:22px;color:var(--ink);margin:0">✅ Jogos finalizados</h2>
      <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:2px 0 14px">${liga.flag || ""} ${liga.name || ""} · ${finalizados.length} encerrado(s) · você fez <b style="color:var(--pitch)">${meusPontos} pts</b> neles</p>
      ${finalizados.length === 0
        ? `<p class="f-mono" style="color:var(--ink-soft);font-size:13px">Nenhum jogo dessa rodada terminou ainda.</p>`
        : `<div style="display:grid;gap:10px">${finalizados.map(cartaoJogo).join("")}</div>`}
    </div>`;
}

function abaClassificacao() {
  const linhas = state.classificacao;
  return `
    <div class="scoreboard" style="min-height:100vh;padding:22px 20px">
      <div class="wrap" style="padding:0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 class="f-display" style="text-transform:uppercase;color:var(--white);margin:0;font-size:18px">👥 Classificação — ${state.grupo.nome}</h3>
          <span class="f-mono" style="font-size:11px;color:var(--paper-soft)">${linhas.length} participante(s)</span>
        </div>
        ${linhas.length === 0 ? `<p class="f-mono" style="color:var(--paper-soft);font-size:13px">Ninguém entrou no grupo ainda além de você. Manda o código pra galera!</p>` : `
          <div>
            ${linhas.map((l, i) => `
              <div>
                <div class="linha-ranking" onclick="toggleGrafico('${l.slug}')" style="background:${state.graficoAberto === l.slug ? "rgba(255,177,0,0.12)" : (i % 2 === 0 ? "rgba(255,255,255,0.04)" : "transparent")}">
                  <div style="display:flex;align-items:center;gap:10px">
                    <span class="f-score" style="font-size:20px;width:22px;text-align:right;color:${l.colocacao === 1 ? "var(--amber)" : "var(--paper-soft)"}">${l.colocacao}</span>
                    ${avatarHtml(l.jogador, l.foto, 30)}
                    <span class="f-mono" style="font-size:13px;color:var(--white)">${l.jogador}</span>
                    ${l.slug === state.meuId ? `<span class="badge" style="background:var(--amber);color:var(--ink)">você</span>` : ""}
                    <span style="font-size:11px;color:var(--paper-soft)">${state.graficoAberto === l.slug ? "▾" : "▸"} 📈</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:10px">
                    <span class="f-mono" style="font-size:11px;color:var(--paper-soft)">${l.exatos} cravados · ${l.acertos} pontuaram</span>
                    <span class="f-score" style="font-size:24px;font-weight:600;color:var(--amber)">${l.total}</span>
                  </div>
                </div>
                ${state.graficoAberto === l.slug
                  ? (state.graficoCache[l.slug] ? montarGraficoInline(state.graficoCache[l.slug], l.slug) : `<div style="padding:20px;text-align:center"><span class="f-mono" style="color:var(--paper-soft);font-size:12px">carregando gráfico…</span></div>`)
                  : ""}
              </div>`).join("")}
          </div>
          <p class="f-mono" style="font-size:11px;color:var(--paper-soft);margin-top:6px;opacity:.75">toque no nome de alguém pra ver o gráfico de posição ao longo da temporada</p>
        `}
        <p class="f-mono" style="font-size:11px;color:rgba(251,248,239,0.55);margin-top:16px;line-height:1.5">
          placar exato = 8 pts · acertou o vencedor = 3 pts · + gols do vencedor certos = 3 · + gols do perdedor certos = 1 · + diferença de gols certa = 2 · empate certo (sem cravar) = 3
        </p>
      </div>
    </div>`;
}

const FAQ = [
  { p: "Os placares são realmente ao vivo?", r: "Sim. O servidor consulta uma API real de futebol automaticamente a cada ~90 segundos, sem precisar de clique." },
  { p: "Como funciona a pontuação?", r: "Placar exato = 8 pontos. Acertar só quem venceu = 3 pontos, mais bônus por acertar os gols do vencedor (+3), do perdedor (+1) e a diferença (+2), que se somam entre si. Empate certo (sem cravar) = 3 pontos." },
  { p: "Como convido meus amigos pro grupo?", r: "Na tela do bolão, toque no código do grupo (no topo) para copiá-lo e mande junto com a senha." },
  { p: "Posso usar minha conta em mais de um celular?", r: "Sim! É só entrar com o mesmo email e senha em qualquer aparelho — seus grupos aparecem automaticamente." },
  { p: "Esqueci a senha do grupo, o que eu faço?", r: "Peça pra quem criou o grupo — só essa pessoa consegue trocar a senha do grupo, em Configurações → Trocar senha do grupo." },
  { p: "Esqueci a senha da minha conta, e agora?", r: "Use 'esqueci minha senha' na tela de login, com o código de recuperação que apareceu quando você criou a conta. Sem esse código, infelizmente não tem como recuperar — guarde ele em lugar seguro." },
  { p: "Como saio de um grupo?", r: "Em Configurações → Sair deste grupo. Isso apaga seus palpites daquele grupo (os outros participantes continuam normalmente)." },
  { p: "Se eu trocar meu apelido, perco meus pontos?", r: "Não — agora sua identidade é a conta (email), não o apelido. Pode trocar o apelido à vontade em Configurações que seus pontos continuam." },
  { p: "Como funciona o lembrete de palpite?", r: "Ative em Configurações → Lembrete de palpite. Quando faltar 1h pra um jogo que você ainda não deu palpite, aparece uma notificação — só funciona com essa página aberta em alguma aba." },
  { p: "Posso jogar em mais de um bolão ao mesmo tempo?", r: "Sim — sua conta pode participar de quantos grupos quiser. A tela inicial mostra 'Seus grupos' com todos eles, e dá pra sincronizar o palpite entre grupos da mesma liga em Configurações, pra não precisar apostar duas vezes." },
];

function abaConfig() {
  return `
    <div class="wrap" style="padding:18px 20px 40px">
      <h2 class="f-display" style="text-transform:uppercase;font-size:20px;color:var(--ink);margin:0 0 14px">⚙️ Configurações e ajuda</h2>

      <div class="card-panel" style="margin-bottom:16px">
        <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:0 0 10px">MINHA CONTA</p>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
          ${avatarHtml(state.conta.nome, state.conta.foto, 56)}
          <div>
            <p class="f-display" style="font-size:16px;color:var(--ink);margin:0 0 2px">${state.conta.nome}</p>
            <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:0 0 8px">${state.conta.email}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="chip btn-dark f-display" style="text-transform:uppercase;font-size:11px;background:var(--pitch)" onclick="selecionarFoto()" ${state.enviandoFoto ? "disabled" : ""}>
                ${state.enviandoFoto ? "Enviando…" : (state.conta.foto ? "Trocar foto" : "Adicionar foto")}
              </button>
              <button class="chip btn-dark f-display" style="text-transform:uppercase;font-size:11px;background:var(--pitch)" onclick="editarApelido()">Trocar apelido</button>
              <input id="input-foto" type="file" accept="image/*" style="display:none" onchange="onFotoSelecionada(this)" />
            </div>
          </div>
        </div>
        <p class="f-mono" style="font-size:12px;color:var(--ink-soft);margin:0 0 10px">Grupo atual: <b style="color:var(--ink)">${state.grupo.nome}</b> (${state.grupo.code})${state.grupo.souCriador ? ` <span class="badge" style="background:var(--gold);color:var(--ink)">você criou</span>` : ""}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="chip btn-dark f-display" style="text-transform:uppercase;font-size:12px;background:var(--pitch)" onclick="trocarDeGrupo()">Trocar de grupo</button>
          ${state.grupo.souCriador ? `<button class="chip btn-dark f-display" style="text-transform:uppercase;font-size:12px;background:var(--pitch)" onclick="trocarSenhaGrupo()">Trocar senha do grupo</button>` : ""}
          <button class="chip btn-dark f-display" style="text-transform:uppercase;font-size:12px;background:var(--live)" onclick="sairDoGrupo()">Sair deste grupo</button>
          <button class="chip btn-dark f-display" style="text-transform:uppercase;font-size:12px;background:var(--pitch)" onclick="sairDaConta()">Sair da conta</button>
        </div>
      </div>

      ${(() => {
        const outrosNaMesmaLiga = state.meusGrupos.filter((g) => g.code !== state.grupo.code && g.liga === state.grupo.liga);
        if (outrosNaMesmaLiga.length === 0) return "";
        const sincronizados = carregarSync();
        return `
          <div class="card-panel" style="margin-bottom:16px">
            <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:0 0 6px">SINCRONIZAR PALPITES</p>
            <p class="f-mono" style="font-size:12px;color:var(--ink-soft);margin:0 0 10px">Marque outro grupo da mesma liga (${LIGAS[state.grupo.liga]?.name || ""}) pra salvar o mesmo palpite nos dois de uma vez só, sem precisar apostar duas vezes.</p>
            ${outrosNaMesmaLiga.map((g) => `
              <label style="display:flex;align-items:center;gap:10px;padding:8px 2px;cursor:pointer">
                <input type="checkbox" ${sincronizados.includes(g.code) ? "checked" : ""} onchange="toggleSyncGrupo('${g.code}')" style="width:16px;height:16px" />
                <span class="f-mono" style="font-size:13px;color:var(--ink)">${g.nome} <span style="color:var(--ink-soft)">(${g.code})</span></span>
              </label>`).join("")}
          </div>`;
      })()}

      <div class="card-panel" style="margin-bottom:16px">
        <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:0 0 10px">AJUDA</p>
        <a href="https://wa.me/5521987606607" target="_blank" rel="noopener" class="chip f-display" style="display:flex;align-items:center;gap:8px;text-decoration:none;background:#25D366;color:#05310F;border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600">
          💬 Falar com o criador — (21) 98760-6607
        </a>
      </div>

      <div class="card-panel" style="margin-bottom:16px">
        <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:0 0 10px">LEMBRETE DE PALPITE</p>
        ${statusNotificacao() === "granted" ? `
          <p class="f-mono" style="font-size:12px;color:var(--ink);margin:0">🔔 Ativado — você recebe um aviso 1h antes de cada jogo que ainda não palpitou.</p>
        ` : statusNotificacao() === "denied" ? `
          <p class="f-mono" style="font-size:12px;color:var(--live);margin:0">Notificações bloqueadas nas configurações do navegador.</p>
        ` : statusNotificacao() === "sem-suporte" ? `
          <p class="f-mono" style="font-size:12px;color:var(--ink-soft);margin:0">Esse navegador não suporta notificações.</p>
        ` : `
          <p class="f-mono" style="font-size:12px;color:var(--ink-soft);margin:0 0 10px">Receba um aviso 1h antes de cada jogo que você ainda não deu palpite.</p>
          <button class="chip btn-amber f-display" style="text-transform:uppercase;font-size:12px" onclick="ativarLembretes()">Ativar lembretes</button>
        `}
        <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin-top:10px;opacity:.8">funciona enquanto essa página estiver aberta no navegador.</p>
      </div>

      <div class="card-panel">
        <p class="f-mono" style="font-size:11px;color:var(--ink-soft);margin:0 0 6px">DÚVIDAS FREQUENTES</p>
        ${FAQ.map((item, i) => `
          <div class="faq-item ${state.faqAberto === i ? "aberto" : ""}">
            <button class="faq-pergunta" onclick="toggleFaq(${i})"><span>${item.p}</span><span>${state.faqAberto === i ? "−" : "+"}</span></button>
            <div class="faq-resposta">${item.r}</div>
          </div>`).join("")}
      </div>
    </div>`;
}
window.toggleFaq = function (i) { state.faqAberto = state.faqAberto === i ? null : i; render(); };

function telaBolao() {
  const liga = LIGAS[state.grupo.liga] || {};
  return `
    <div>
      <header class="pitch-stripes" style="padding:26px 20px 22px">
        <div class="wrap" style="padding:0;display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div style="min-width:0">
            <div class="f-mono" style="color:var(--amber);font-size:11px;display:flex;align-items:center;gap:6px">🛡️ ${state.grupo.nome}</div>
            <h1 class="f-display" style="text-transform:uppercase;font-weight:700;font-size:28px;margin:2px 0 0;color:var(--white)">Bolão</h1>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
              ${avatarHtml(state.conta.nome, state.conta.foto, 26)}
              <p class="f-mono" style="color:var(--paper-soft);font-size:11px;margin:0">jogando como <b style="color:var(--amber)">${state.conta.nome}</b></p>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
            ${state.melhorRodada ? `
              <div class="chip" style="display:flex;align-items:center;gap:6px;background:var(--paper);border-radius:9px;padding:6px 10px;max-width:170px" title="Melhor da rodada ${state.melhorRodada.matchday}">
                ${avatarHtml(state.melhorRodada.jogador, state.melhorRodada.foto, 20)}
                <span class="f-mono" style="font-size:10px;color:var(--ink);line-height:1.25">🏅 <b>${state.melhorRodada.jogador}</b><br/>${state.melhorRodada.pontos} pts na rodada</span>
              </div>` : ""}
            <button class="icon-btn" title="Configurações" onclick="setAbaBolao('config')">⚙️</button>
          </div>
        </div>

        <div class="wrap" style="padding:0;margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button class="chip" style="display:flex;align-items:center;gap:8px;background:var(--paper);border-radius:9px;padding:8px 12px" onclick="copiarCodigo()">
            <span>🔑</span><span class="code-plate" style="font-size:14px;color:var(--ink)">${state.grupo.code}</span><span>${state.copiado ? "✓" : "📋"}</span>
          </button>
          <span class="f-mono" style="font-size:11px;color:var(--paper-soft)">compartilhe código + senha com a galera</span>
        </div>

        <div class="wrap" style="padding:0;margin-top:14px">
          <div class="tabbar">
            <button class="${state.abaBolao === "jogos" ? "ativo" : ""}" onclick="setAbaBolao('jogos')">🎟️ Jogos</button>
            <button class="${state.abaBolao === "finalizados" ? "ativo" : ""}" onclick="setAbaBolao('finalizados')">✅ Finalizados</button>
            <button class="${state.abaBolao === "classificacao" ? "ativo" : ""}" onclick="setAbaBolao('classificacao')">🏆 Classificação</button>
          </div>
        </div>
      </header>

      <div style="background:var(--paper-soft)">
        ${state.abaBolao === "jogos" ? abaJogos() : ""}
        ${state.abaBolao === "finalizados" ? abaFinalizados() : ""}
        ${state.abaBolao === "config" ? abaConfig() : ""}
      </div>
      ${state.abaBolao === "classificacao" ? abaClassificacao() : ""}
    </div>`;
}

/* ---------------- render principal ---------------- */

function render() {
  const el = document.getElementById("app");
  if (state.view === "carregando") el.innerHTML = `<div class="center-screen f-mono" style="color:var(--paper-soft)">carregando bolão…</div>`;
  else if (state.view === "reconectando") el.innerHTML = `<div class="center-screen f-mono" style="color:var(--paper-soft);text-align:center;padding:20px">🔌 conectando ao servidor…<br/><span style="font-size:11px;opacity:.7">o servidor grátis às vezes demora uns segundos pra acordar</span></div>`;
  else if (state.view === "erro-conexao") el.innerHTML = `
    <div class="center-screen" style="text-align:center;padding:20px">
      <p class="f-mono" style="color:var(--paper-soft);font-size:13px;margin-bottom:14px">Não consegui falar com o servidor agora. Sua conta continua salva — tenta de novo.</p>
      <button class="chip btn-amber f-display" style="text-transform:uppercase" onclick="tentarDeNovo()">Tentar de novo</button>
    </div>`;
  else if (state.view === "conta") el.innerHTML = telaConta();
  else if (state.view === "codigo-recuperacao") el.innerHTML = telaCodigoRecuperacao();
  else if (state.view === "home") el.innerHTML = telaHome();
  else if (state.view === "bolao") el.innerHTML = telaBolao();
}

iniciar();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
