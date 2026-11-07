<p align="center">
  <img src="gg-app/icon-source.png" alt="GG Coder app icon" width="128">
</p>

<p align="center">
  <img src="docs/art/home.png" alt="GG Coder desktop home screen">
</p>

<p align="center">
  <strong>Porque os outros agentes me tiram do sério.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <strong>Português</strong> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/gg-framework?style=for-the-badge&label=Download&color=b0b6ff" alt="GG Coder desktop release"></a>
  <a href="https://github.com/KenKaiii/gg-framework"><img src="https://img.shields.io/github/stars/KenKaiii/gg-framework?style=for-the-badge&label=Stars&color=yellow" alt="Star GG Coder on GitHub"></a>
  <a href="https://github.com/KenKaiii/gg-framework/releases"><img src="https://img.shields.io/github/downloads/KenKaiii/gg-framework/total?style=for-the-badge&label=App%20downloads&color=2ecc71" alt="Desktop app downloads"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/dm/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI%20downloads&color=2ecc71" alt="ggcoder npm downloads per month"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI&color=blue" alt="ggcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-b0b6ff?style=for-the-badge" alt="Skool"></a>
</p>

<sub>Esta é uma tradução e pode estar desatualizada em relação à versão em inglês. Em caso de diferença, vale o [README em inglês](README.md).</sub>

GG Coder é um agente de programação para desktop que tira mais proveito da assinatura de IA que você já paga.

> ⭐ **Se o GG Coder economiza seu tempo ou dinheiro, deixe uma estrela.** É a principal forma de outros desenvolvedores o encontrarem.

## Por que o GG Coder

- **Mais trabalho por plano.** O mais rápido e econômico entre 20 agentes que coloquei para competir no mesmo modelo. O Claude Code gastou 169% a mais para o mesmo trabalho.
- **Código real, não chute.** O Agent Steroids pesquisa código aberto real e atual na sua máquina. Sem servidor MCP com limite de requisições, sem limites.
- **Pronto significa verificado.** O Ken Autopilot continua o trabalho até tudo estar realmente verificado.
- **Lance do jeito certo, mesmo sendo iniciante.** Programar é só uma parte. Verificações com um clique de segurança, conformidade, proteção de dados, acessibilidade, testes e mais, além de uma nota de Project health, para você não precisar saber o que pedir.
- **Suas assinaturas.** Planos Claude, ChatGPT, Kimi Code, MiniMax e MiMo, qualquer chave de API ou modelos locais.

| Agente             | Tempo do conjunto completo | Uso por conjunto | Tempo vs GG Coder | Uso vs GG Coder |
| ------------------ | -------------------------- | ---------------- | ----------------- | --------------- |
| **GG Coder**       | **102 s**                  | **$0.014**       |                   |                 |
| Codewhale          | 112 s                      | $0.022           | 10% mais lento    | 58% a mais      |
| Goose              | 132 s                      | $0.020           | 29% mais lento    | 46% a mais      |
| GitHub Copilot CLI | 136 s                      | $0.025           | 33% mais lento    | 83% a mais      |
| Kimi Code          | 138 s                      | $0.024           | 36% mais lento    | 74% a mais      |
| Claude Code        | 142 s                      | $0.037           | 39% mais lento    | 169% a mais     |
| ForgeCode          | 155 s                      | $0.042           | 52% mais lento    | 204% a mais     |
| Dirac              | 160 s                      | $0.029           | 57% mais lento    | 114% a mais     |
| Crush              | 165 s                      | $0.037           | 62% mais lento    | 173% a mais     |
| Factory Droid      | 167 s                      | $0.025           | 64% mais lento    | 83% a mais      |
| Mistral Vibe       | 169 s                      | $0.036           | 66% mais lento    | 164% a mais     |
| DeepSeek-Reasonix  | 170 s                      | $0.027           | 67% mais lento    | 99% a mais      |
| Oh My Pi           | 170 s                      | $0.031           | 67% mais lento    | 123% a mais     |
| Xum                | 172 s                      | $0.041           | 69% mais lento    | 203% a mais     |
| Docker Agent       | 173 s                      | $0.021           | 70% mais lento    | 51% a mais      |
| Qwen Code          | 177 s                      | $0.049           | 74% mais lento    | 257% a mais     |
| Prime Agent        | 190 s                      | $0.029           | 86% mais lento    | 111% a mais     |
| Hermes Agent       | 190 s                      | $0.027           | 87% mais lento    | 100% a mais     |
| Deep Agents        | 201 s                      | $0.041           | 97% mais lento    | 198% a mais     |
| jcode              | 380 s                      | $0.178           | 274% mais lento   | 1196% a mais    |

<sub>Tabela: uma corrida completa em 4 de novembro de 2026. 20 agentes, cada um na versão estável atual (GG Coder v0.102.0), 7 tarefas, 5 execuções cada (700 execuções), todos no Claude Haiku 5.5 com a mesma configuração de raciocínio. Todos os agentes receberam os mesmos prompts e uma cópia nova do projeto a cada execução, e rodaram sem extras, GG Coder incluído: só com o próprio prompt e as ferramentas embutidas, sem skills, plugins, servidores MCP ou instruções personalizadas. As tarefas usam pequenos projetos de teste e uma pergunta sobre o código do Vite (v8.3.5), então nenhum agente trabalha no próprio código. Uma execução só conta se os testes ocultos passarem ou a resposta estiver correta.</sub>

## Também incluso

- **GG Goals:** entregue um objetivo inteiro e uma equipe de workers leva até o fim.
- **Chat:** conversas que lembram o contexto.
- **GG Motion:** transforma suas ideias em vídeos.

## Primeiros passos

1. Instale o GG Coder:

   **macOS (Apple Silicon):** [baixe a versão mais recente](https://github.com/KenKaiii/gg-framework/releases/latest) e abra o `.dmg`.

   **Windows:** [baixe a versão mais recente](https://github.com/KenKaiii/gg-framework/releases/latest) e execute o instalador `.exe`.

   **Linux (x86_64):** [baixe a versão mais recente](https://github.com/KenKaiii/gg-framework/releases/latest) e instale o `.deb` (`sudo apt install ./GG*.deb`) ou o `.rpm` (`sudo dnf install ./GG*.rpm`).

   **Desenvolvimento:** com Node.js, pnpm e os [pré-requisitos do Tauri](https://v2.tauri.app/start/prerequisites/) instalados:

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. Abra o app, conecte seu provedor de IA e escolha Code, Chat ou Motion.

## Construa com o framework

Quer o motor sem o app desktop? Use os mesmos pacotes nos seus próprios apps. Instale só o que precisar.

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): Conecte-se a provedores de IA e receba respostas em streaming.
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): Crie agentes que usam suas ferramentas e resolvem tarefas.
- [**@kenkaiiii/gg-core**](packages/gg-core/README.md): Seleção de modelos, autenticação e descoberta de modelos locais.
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): O agente de programação, as sessões e as ferramentas por trás do app e da CLI.

Para o seu próprio agente, comece aqui:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

Os links dos pacotes acima explicam configuração e uso. Licenciado sob AGPL-3.0: você pode construir em cima dele e, se distribuir suas alterações ou rodá-las como serviço de rede, deve compartilhar o código-fonte delas sob a mesma licença.

## Contribuindo

Relatos de bugs, ideias e pull requests são bem-vindos. Leia o [CONTRIBUTING.md](CONTRIBUTING.md) e o [Código de Conduta](CODE_OF_CONDUCT.md) antes de começar.

## Aprenda comigo

Venha construir comigo na minha [comunidade no Skool](https://skool.com/kenkai). Tire dúvidas, mostre o que está criando e aprenda a aproveitar mais a IA.

## Histórico de estrelas

<a href="https://star-history.com/#KenKaiii/gg-framework&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date&amp;theme=dark">
    <img alt="Gráfico do histórico de estrelas do GG Coder" src="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date">
  </picture>
</a>

<p align="center">Se o GG Coder for útil para você, ⭐ deixe uma estrela no repositório para que mais pessoas o encontrem.</p>
