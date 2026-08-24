/* Service worker mínimo — necessário pro navegador considerar o site "instalável"
   como app. Não guarda nada offline de propósito: o bolão precisa de conexão
   com o servidor pra funcionar (placares ao vivo, grupos, etc). */

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
