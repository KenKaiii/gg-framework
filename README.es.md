<p align="center">
  <img src="gg-app/icon-source.png" alt="GG Coder app icon" width="128">
</p>

<p align="center">
  <img src="docs/art/home.png" alt="GG Coder desktop home screen">
</p>

<p align="center">
  <strong>Porque los demás agentes me sacan de quicio.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <strong>Español</strong> | <a href="README.pt-BR.md">Português</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/gg-framework?style=for-the-badge&label=Download&color=b0b6ff" alt="GG Coder desktop release"></a>
  <a href="https://github.com/KenKaiii/gg-framework/stargazers"><img src="https://img.shields.io/github/stars/KenKaiii/gg-framework?style=for-the-badge&label=Stars&color=yellow" alt="Star GG Coder on GitHub"></a>
  <a href="https://github.com/KenKaiii/gg-framework/releases"><img src="https://img.shields.io/github/downloads/KenKaiii/gg-framework/total?style=for-the-badge&label=App%20downloads&color=2ecc71" alt="Desktop app downloads"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/dm/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI%20downloads&color=2ecc71" alt="ggcoder npm downloads per month"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI&color=blue" alt="ggcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-b0b6ff?style=for-the-badge" alt="Skool"></a>
</p>

<sub>Esta es una traducción y puede ir por detrás de la versión en inglés. Si hay diferencias, manda el [README en inglés](README.md).</sub>

GG Coder es un agente de programación de escritorio que saca más partido a la suscripción de IA que ya pagas.

> ⭐ **Si GG Coder te ahorra tiempo o dinero, dale una estrella.** Es la principal forma en que otros desarrolladores lo descubren.

## Por qué GG Coder

- **Más trabajo por plan.** El más rápido y eficiente de 20 agentes que puse a competir con el mismo modelo. Claude Code consumió un 169% más para el mismo trabajo.
- **Código real, no suposiciones.** Agent Steroids busca código abierto real y actual en tu equipo. Sin servidores MCP con límite de peticiones, sin límites.
- **Terminado significa comprobado.** Ken Autopilot sigue trabajando hasta que todo está realmente verificado.
- **Publica bien, aunque estés empezando.** Programar es solo una parte. Revisiones con un clic de seguridad, cumplimiento normativo, protección de datos, accesibilidad, tests y más, además de una puntuación de Project health, para que no necesites saber qué pedir.
- **Tus suscripciones.** Claude, ChatGPT, Gemini, Grok, Kimi, claves de API o modelos locales.

| Agente             | Tiempo de la batería completa | Consumo por batería | Tiempo vs GG Coder | Consumo vs GG Coder |
| ------------------ | ----------------------------- | ------------------- | ------------------ | ------------------- |
| **GG Coder**       | **102 s**                     | **$0.014**          |                    |                     |
| Codewhale          | 112 s                         | $0.022              | 10% más lento      | 58% más             |
| Goose              | 132 s                         | $0.020              | 29% más lento      | 46% más             |
| GitHub Copilot CLI | 136 s                         | $0.025              | 33% más lento      | 83% más             |
| Kimi Code          | 138 s                         | $0.024              | 36% más lento      | 74% más             |
| Claude Code        | 142 s                         | $0.037              | 39% más lento      | 169% más            |
| ForgeCode          | 155 s                         | $0.042              | 52% más lento      | 204% más            |
| Dirac              | 160 s                         | $0.029              | 57% más lento      | 114% más            |
| Crush              | 165 s                         | $0.037              | 62% más lento      | 173% más            |
| Factory Droid      | 167 s                         | $0.025              | 64% más lento      | 83% más             |
| Mistral Vibe       | 169 s                         | $0.036              | 66% más lento      | 164% más            |
| DeepSeek-Reasonix  | 170 s                         | $0.027              | 67% más lento      | 99% más             |
| Oh My Pi           | 170 s                         | $0.031              | 67% más lento      | 123% más            |
| Xum                | 172 s                         | $0.041              | 69% más lento      | 203% más            |
| Docker Agent       | 173 s                         | $0.021              | 70% más lento      | 51% más             |
| Qwen Code          | 177 s                         | $0.049              | 74% más lento      | 257% más            |
| Prime Agent        | 190 s                         | $0.029              | 86% más lento      | 111% más            |
| Hermes Agent       | 190 s                         | $0.027              | 87% más lento      | 100% más            |
| Deep Agents        | 201 s                         | $0.041              | 97% más lento      | 198% más            |
| jcode              | 380 s                         | $0.178              | 274% más lento     | 1196% más           |

<sub>Tabla: una carrera completa el 4 de noviembre de 2026. 20 agentes, cada uno en su versión estable actual (GG Coder v0.102.0), 7 tareas, 5 ejecuciones cada una (700 ejecuciones), todos con Claude Haiku 5.5 y la misma configuración de razonamiento. Cada agente recibió los mismos prompts y una copia nueva del proyecto en cada ejecución, y se ejecutó tal cual, GG Coder incluido: con su propio prompt y herramientas integrados, sin skills, plugins, servidores MCP ni instrucciones personalizadas. Las tareas usan pequeños proyectos de prueba más una pregunta sobre el código de Vite (v8.3.5), así que ningún agente trabaja sobre su propio código. Una ejecución solo cuenta si pasan los tests ocultos o la respuesta es correcta.</sub>

## También incluye

- **GG Goals:** entrega un objetivo completo y un equipo de workers lo lleva hasta el final.
- **Chat:** conversaciones que recuerdan el contexto.
- **GG Motion:** convierte tus ideas en vídeos.

## Primeros pasos

1. Instala GG Coder:

   **macOS (Apple Silicon):** [descarga la última versión](https://github.com/KenKaiii/gg-framework/releases/latest) y abre el `.dmg`.

   **Windows:** [descarga la última versión](https://github.com/KenKaiii/gg-framework/releases/latest) y ejecuta el instalador `.exe`.

   **Linux (x86_64):** [descarga la última versión](https://github.com/KenKaiii/gg-framework/releases/latest) e instala el `.deb` (`sudo apt install ./GG*.deb`) o el `.rpm` (`sudo dnf install ./GG*.rpm`).

   **Desarrollo:** con Node.js, pnpm y los [requisitos previos de Tauri](https://v2.tauri.app/start/prerequisites/) instalados:

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. Abre la app, conecta tu proveedor de IA y elige Code, Chat o Motion.

## Construye con el framework

¿Quieres el motor sin la app de escritorio? Usa los mismos paquetes en tus propias apps. Instala solo lo que necesites.

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): Conecta con proveedores de IA y recibe las respuestas en streaming.
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): Crea agentes que usan tus herramientas y resuelven tareas.
- [**@kenkaiiii/gg-core**](packages/gg-core/README.md): Selección de modelos, autenticación y detección de modelos locales.
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): El agente de programación, las sesiones y las herramientas detrás de la app y la CLI.

Para tu propio agente, empieza aquí:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

Los enlaces de los paquetes explican la configuración y el uso. Con licencia AGPL-3.0: puedes construir sobre él y, si distribuyes tus cambios o los ofreces como servicio en red, debes compartir su código fuente bajo la misma licencia.

## Contribuir

Los reportes de bugs, las ideas y los pull requests son bienvenidos. Lee [CONTRIBUTING.md](CONTRIBUTING.md) y el [Código de Conducta](CODE_OF_CONDUCT.md) antes de empezar.

## Aprende conmigo

Ven a construir conmigo en mi [comunidad de Skool](https://skool.com/kenkai). Consigue ayuda, comparte lo que estás haciendo y aprende a sacarle más partido a la IA.

## Historial de estrellas

<a href="https://star-history.com/#KenKaiii/gg-framework&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date&amp;theme=dark">
    <img alt="Gráfico del historial de estrellas de GG Coder" src="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date">
  </picture>
</a>

<p align="center">Si GG Coder te resulta útil, ⭐ dale una estrella al repositorio para que más gente lo encuentre.</p>
