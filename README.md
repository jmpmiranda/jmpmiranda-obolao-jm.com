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
atualizando sozinho (durante jogos, a cada ~20 segundos; o navegador busca essa informação
do servidor a cada 20 segundos).

## Como funciona por baixo dos panos

- `server.js` roda um "poller" que consulta a API da football-data.org para
  cada uma das ligas (varredura completa a cada 3 min e, durante os jogos, uma consulta rápida a cada ~20 s; respeitando o limite de 10
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

## Se todo mundo for deslogado e "email ou senha incorretos"

Quase sempre é o **Upstash** suspendendo o banco, não os dados sumindo. O plano
grátis tem limites por mês (10 GB de banda e 500 mil comandos); passando de um
deles o banco é **suspenso** ("Database is suspended due to monthly bandwidth
limit") e o app passa a não enxergar nenhuma conta. Confira em
**console.upstash.com → seu banco**: o aviso aparece no topo, e o campo
"Storage" mostra se os dados continuam lá (algumas centenas de KB = salvos).
Nos logs do Render aparece `ERRO ao ler o banco (nada foi sobrescrito)`.

O que estourava era a **banda**: o banco inteiro (fotos incluídas, ~250 KB) era
baixado a cada pedido de cada pessoa. Desde esta versão o servidor lê o banco
**uma vez só** (quando liga) e passa a usar a cópia em memória; só grava quando
algo muda (juntando várias mudanças numa gravação só, em até 3 s, e gravando
também ao ser desligado). E se a leitura falhar, o servidor responde
"instabilidade" em vez de fingir que o banco está vazio — então nunca mais grava
um banco vazio por cima do real.

Pra reativar um banco suspenso: esperar a virada do mês, ou fazer upgrade
(pay-as-you-go, com cartão; com esta versão o uso fica perto de zero).

## Notificações no celular (início, gols e fim de jogo)

Quem ativar em **Configurações → Notificações dos jogos** recebe no celular,
**mesmo com o app fechado**: início do jogo, cada gol (com o placar e quantos
pontos o seu palpite vale naquele momento), o fim de jogo com seus pontos e, 1h
antes, um aviso se você ainda não palpitou.

**Só dos times que a pessoa segue.** Na aba **📊 Tabela** de cada bolão tem um
botão "seguir" ao lado de cada time (dá pra seguir vários) e um "seguir tudo"
em cima. Jogo de time que não é seguido não gera nenhuma notificação — nem o
lembrete de 1h. Quem ativou as notificações mas ainda não seguiu ninguém não
recebe nada até escolher. Cada jogo ocupa uma notificação só: a nova substitui
a anterior. Cada evento (ex.: "gol, 1x0") é enviado uma única vez.

Como funciona: o servidor consulta os placares sozinho; quando vê que um jogo
começou, que saiu gol ou que acabou, manda um Web Push pros aparelhos
inscritos. As chaves de envio (VAPID) são criadas sozinhas na primeira vez e
guardadas no Upstash.

- **iPhone:** só funciona com o app instalado (Compartilhar → Adicionar à Tela
  de Início) e iOS 16.4 ou mais novo.
- **Render grátis dorme** sem visitas, e servidor dormindo não vê gol. Por isso
  ele se "cutuca" sozinho a cada 10 min (`/health`). Pra desligar:
  `MANTER_ACORDADO=0`. Um monitor externo gratuito (UptimeRobot) batendo em
  `/health` a cada 5 min também serve de reforço.
- Um placar fixo na tela de bloqueio (tipo "Live Activity" do iPhone) só existe
  em app nativo; o app web faz uma notificação que se atualiza a cada gol.
- A permissão é por aparelho: cada celular precisa ativar uma vez.

## Tabela do campeonato e escalações

- A aba **📊 Tabela** mostra a classificação do campeonato do bolão e é
  atualizada sempre que um jogo termina (e a cada 10 min por garantia).
- Ao tocar num jogo **ao vivo** (ou encerrado) abre a folha do jogo com o
  placar, os **palpites do grupo** e as **escalações**.
- **Escalações:** a football-data.org só inclui escalações nos planos pagos. No
  plano grátis a folha mostra "escalação ainda não disponível"; se você assinar
  um plano com escalações, passa a aparecer sozinha.

## Atraso dos placares (plano grátis da football-data.org)

O plano grátis dessa API entrega os placares **com atraso de alguns minutos**
em relação à TV — isso vem da própria API, não do app. Durante os jogos, uma
única consulta a cada ~20 s traz as 7 ligas de uma vez; fora dos jogos o
servidor não gasta consulta nenhuma. Gol em tempo real só no plano pago de
"livescores" deles.

## Removendo participantes de um grupo

Só quem **criou** o grupo vê o botão **✕ Remover**: em Configurações →
Participantes, ou tocando no nome da pessoa na Classificação. A pessoa perde
os palpites daquele grupo e **não consegue voltar com a senha atual** — se
quiser deixá-la entrar de novo, troque a senha do grupo.

## Palpites combinados fora do app (importar-palpites.json)

Se o app ficou fora do ar e os palpites foram juntados pelo WhatsApp, o arquivo
`importar-palpites.json` (na raiz do projeto) lista, por grupo e por pessoa, os
jogos e placares. O servidor lança tudo sozinho:

- acha cada jogo pelo **nome dos times + data** (ignora acento e maiúscula);
- a pessoa precisa ser **membro do grupo**, com o **mesmo nome** que tem no app;
- **nunca sobrescreve** um palpite que a pessoa já fez no app, e cada palpite é
  lançado uma vez só;
- se o banco ainda estiver indisponível, espera e tenta de novo a cada 3 min;
- os pontos saem sozinhos, pelo resultado real que o servidor busca na API.

O resultado aparece nos logs do Render, numa linha que começa com
`📥 importação de palpites:`. Isso lança palpite depois do jogo, então só use
com palpites mandados **antes** do jogo começar (guarde as mensagens).

## Esqueci a senha e não tenho o código de recuperação

- O **criador do grupo** abre Configurações → Participantes e toca em **🔑 Senha**
  ao lado do nome da pessoa: o app mostra uma senha temporária (8 caracteres).
  A pessoa entra com o email de sempre + essa senha. Só funciona para membros
  do grupo de quem pede, nunca para a própria conta, e derruba as sessões abertas
  dela. Não mexe no código de recuperação.
- Depois, em **Configurações → Minha senha e código de recuperação**, a pessoa
  troca a senha por uma que escolha e **gera um novo código de recuperação**
  (aparece uma única vez — anotar).

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
- Empate certo sem cravar o placar: **5 pontos** (3 por acertar o empate + 2 pela diferença de gols, que num empate é sempre 0×0)
