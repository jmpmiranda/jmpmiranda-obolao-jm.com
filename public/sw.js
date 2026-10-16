/* Service worker — duas funções:
   1) deixa o site "instalável" como app;
   2) recebe as notificações do servidor (push) e mostra na tela do celular, mesmo com o app fechado.
   Não guarda nada offline de propósito: o bolão precisa de conexão com o servidor. */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // apenas repassa a requisição pra rede normalmente
  event.respondWith(fetch(event.request));
});

/* chega uma notificação do servidor (início de jogo, gol, fim, lembrete) */
self.addEventListener("push", (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch {
    dados = { title: "ALLeagues", body: event.data ? event.data.text() : "" };
  }
  const opcoes = {
    body: dados.body || "",
    icon: dados.icon || "/icons/icon-192.png",
    // mesma "tag" = a notificação nova SUBSTITUI a anterior do mesmo jogo (placar sempre atualizado)
    tag: dados.tag || undefined,
    renotify: !!dados.tag && dados.renotify !== false,
    // início/gol ficam fixos na tela até a pessoa dispensar (em aparelhos que respeitam isso)
    requireInteraction: !!dados.fixa,
    data: { url: dados.url || "/" },
  };
  // o navegador exige mostrar uma notificação a cada push recebido
  event.waitUntil(self.registration.showNotification(dados.title || "ALLeagues", opcoes));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
      for (const j of janelas) {
        if ("focus" in j) return j.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
