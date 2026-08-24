/* Regras de pontuação do bolão — usado tanto no servidor (Node) quanto no navegador */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Pontuacao = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function pointsFor(pick, game) {
    if (!pick || game.status === "scheduled") return null;
    const hs = game.hs, as = game.as;
    const h = pick.h ?? 0, a = pick.a ?? 0;
    if (h === hs && a === as) return { total: 8, tags: ["placar exato"] };

    const realDiff = hs - as;
    const pickDiff = h - a;
    const realDraw = realDiff === 0;
    const pickDraw = pickDiff === 0;

    if (realDraw) return pickDraw ? { total: 3, tags: ["empate certo"] } : { total: 0, tags: [] };
    if (pickDraw) return { total: 0, tags: [] };

    const realWinnerHome = realDiff > 0;
    const pickWinnerHome = pickDiff > 0;
    if (realWinnerHome !== pickWinnerHome) return { total: 0, tags: [] };

    let total = 3;
    const tags = ["vencedor certo"];
    const winnerReal = realWinnerHome ? hs : as;
    const loserReal = realWinnerHome ? as : hs;
    const winnerPick = realWinnerHome ? h : a;
    const loserPick = realWinnerHome ? a : h;

    if (winnerPick === winnerReal) { total += 3; tags.push("gols do vencedor"); }
    if (loserPick === loserReal) { total += 1; tags.push("gols do perdedor"); }
    if (Math.abs(pickDiff) === Math.abs(realDiff)) { total += 2; tags.push("diferença de gols"); }

    return { total, tags };
  }

  function classificacao(membros, palpites, jogos) {
    const linhas = Object.entries(membros).map(([slug, m]) => {
      const picks = palpites[slug] || {};
      let total = 0, exatos = 0, acertos = 0, avaliados = 0;
      for (const jg of jogos) {
        const p = pointsFor(picks[jg.id], jg);
        if (p) {
          avaliados++;
          total += p.total;
          if (p.total === 8) exatos++;
          if (p.total > 0) acertos++;
        }
      }
      return { slug, jogador: m.nome, total, exatos, acertos, avaliados };
    });
    linhas.sort((a, b) => b.total - a.total || b.exatos - a.exatos || a.jogador.localeCompare(b.jogador));
    let rank = 0, anterior = null;
    linhas.forEach((l, i) => {
      if (l.total !== anterior) { rank = i + 1; anterior = l.total; }
      l.colocacao = rank;
    });
    return linhas;
  }

  return { pointsFor, classificacao };
});
