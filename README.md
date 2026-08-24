# Bolão de futebol — com grupos por código/senha e placar automático

App completo (backend + frontend) para fazer um bolão com os amigos. Cada
grupo tem um código e uma senha; a liga é escolhida na criação; os placares
são buscados sozinhos de uma API real de futebol, sem precisar clicar em
"atualizar".

## O que você precisa

- Node.js 18 ou mais novo instalado (https://nodejs.org)
- Uma chave grátis da football-data.org: crie uma conta em
  https://www.football-data.org/client/register (é gratuito, plano free
  cobre Premier League, La Liga, Serie A, Bundesliga e Ligue 1 — as 5 ligas
  que este app já vem configurado para usar)

## Rodando na sua máquina

```bash
cd bolao-app
cp .env.example .env
# edite o .env e cole sua chave em FOOTBALL_DATA_API_KEY
npm install
npm start
```

Abra http://localhost:3000 no navegador. Pronto — o servidor já começa a
buscar os placares reais automaticamente assim que sobe, e continua
atualizando sozinho a cada ~90 segundos (o navegador busca essa informação
do servidor a cada 20 segundos).

## Como funciona por baixo dos panos

- `server.js` roda um "poller" que consulta a API da football-data.org para
  cada uma das 5 ligas, a cada 90 segundos (respeitando o limite de 10
  chamadas/minuto do plano grátis).
- Os placares ficam guardados em memória (`scoresCache`) e são servidos pra
  qualquer grupo que esteja usando aquela liga.
- Sempre que o número de jogos encerrados de uma liga muda, o servidor tira
  uma "foto" da classificação de cada grupo daquela liga e guarda no
  histórico — é esse histórico que vira o gráfico de "subiu/desceu no
  ranking" quando você toca no nome de alguém.
- Grupos, membros, palpites e histórico ficam salvos em `data/db.json`.

## Hospedando de verdade (pra funcionar 24h, não só no seu PC)

Qualquer serviço que rode Node.js funciona. Dois exemplos fáceis, com plano
grátis:

**Render.com**
1. Suba esta pasta num repositório do GitHub.
2. Em render.com, crie um "New Web Service" apontando pro repositório.
3. Build command: `npm install` — Start command: `npm start`.
4. Em "Environment", adicione as variáveis `FOOTBALL_DATA_API_KEY`,
   `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` (veja a seção acima
   sobre o Upstash — sem essas duas últimas, os grupos se perdem toda vez que
   o serviço dormir/reiniciar).
5. Deploy. A URL que o Render te der é o link que você manda pros amigos.

**Railway.app** segue o mesmo esquema: conectar o repositório, definir as
variáveis de ambiente e rodar `npm start`.

## Estrutura dos arquivos

```
bolao-app/
  server.js          → backend (Express) + poller da API + regras de negócio
  public/
    scoring.js        → regras de pontuação (compartilhado servidor/navegador)
    index.html
    style.css
    app.js             → toda a interface (telas, abas, gráfico, config/FAQ)
  data/db.json         → onde os grupos ficam salvos (criado automaticamente)
  .env.example
```

## Contas de verdade (email/senha)

Cada pessoa cria uma conta com email e senha (na primeira tela do app). Isso
significa:

- A mesma conta funciona em qualquer celular ou computador — não precisa
  recriar nada em cada aparelho, basta entrar de novo com email e senha.
- O apelido, a foto de perfil e os grupos que você participa ficam ligados à
  conta, não ao navegador — a lista "Seus grupos" vem direto do servidor.
- Trocar de apelido (em Configurações) não faz você perder pontos — sua
  identidade pro sistema é o email; o apelido é só o nome exibido.
- Dentro de um grupo, duas contas diferentes não podem usar o mesmo apelido
  — se der conflito, o app pede pra mudar o apelido antes de entrar.

As senhas ficam guardadas com hash (nunca em texto puro), mas não é um
sistema de segurança de nível bancário — é o suficiente pra separar as
pessoas de um bolão de amigos, não pra dados sensíveis de verdade.

## Foto de perfil

Na aba de configurações (ícone ⚙️ no topo), cada pessoa pode adicionar uma
foto — ela vale pra conta inteira, aparece em todos os grupos que a pessoa
participa. É redimensionada no próprio navegador antes de enviar (fica
pequena, não pesa no banco de dados). Quem não colocar foto aparece com um
círculo com a inicial do apelido.

## Escudos dos times

Os cards de jogo mostram o escudo de cada time (vem direto da API de
futebol) em cima do nome. Se algum escudo não carregar, o espaço fica em
branco sem quebrar o layout.

## Abas dentro do grupo

- **Jogos** — só os jogos que ainda vão rolar ou que estão ao vivo agora.
- **Finalizados** — jogos já encerrados dessa rodada, com o placar final e
  quantos pontos seu palpite rendeu em cada um.
- **Classificação** — o ranking do grupo; toque em alguém pra ver o gráfico
  de posição ao longo da rodada.

## Não perdendo os grupos quando hospedar (Upstash)

Rodando só na sua máquina, os grupos ficam salvos em `data/db.json` e isso é
suficiente. Mas serviços de hospedagem grátis (Render incluso) apagam esse
arquivo toda vez que o servidor reinicia — e no plano grátis isso acontece com
frequência (ele "dorme" depois de 15 minutos sem acesso, e ao acordar já não
tem mais o arquivo).

Pra resolver isso de graça, sem expiração, o projeto já vem preparado pra usar
o [Upstash](https://upstash.com) (um banco Redis com plano grátis permanente):

1. Crie uma conta grátis em upstash.com (dá pra entrar com GitHub).
2. Crie um banco Redis novo (qualquer região serve).
3. Na página do banco, copie o **REST URL** e o **REST TOKEN**.
4. Cole os dois no seu `.env` (local) e/ou nas variáveis de ambiente do Render
   (produção), nos campos `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.

Com essas duas variáveis configuradas, o servidor passa a salvar tudo no
Upstash automaticamente — sem elas, ele continua usando o arquivo local (bom
pra testar, mas não pra produção).

## Instalando como app no celular (PWA, de graça)

Depois que o site estiver no ar (Render), qualquer pessoa pode instalá-lo como
se fosse um app de verdade — ícone na tela inicial, tela cheia, sem barra de
endereço. Não precisa de loja de aplicativos nem custa nada.

**Android/Chrome:** abra o link do bolão, toque nos três pontinhos (⋮) no
canto e escolha "Adicionar à tela inicial" ou "Instalar app" (o Chrome às
vezes oferece isso sozinho, com um banner).

**iPhone/Safari:** abra o link, toque no ícone de compartilhar (□ com uma
seta pra cima) e escolha "Adicionar à Tela de Início".

## Pontuação

- Placar exato: **8 pontos**
- Acertou só quem venceu: **3 pontos**
- + acertou os gols do vencedor: **+3**
- + acertou os gols do perdedor: **+1**
- + acertou a diferença de gols: **+2**
- Empate certo sem cravar o placar: **3 pontos**
