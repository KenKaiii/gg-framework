<p align="center">
  <img src="gg-app/icon-source.png" alt="GG Coder app icon" width="128">
</p>

<p align="center">
  <img src="docs/art/home.png" alt="GG Coder desktop home screen">
</p>

<p align="center">
  <strong>Weil mich die anderen Agents tierisch nerven.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <strong>Deutsch</strong> | <a href="README.fr.md">Français</a>
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

<sub>Dies ist eine Übersetzung und kann hinter der englischen Version zurückliegen. Im Zweifel gilt die [englische README](README.md).</sub>

GG Coder ist ein Coding-Agent für den Desktop, der mehr aus dem KI-Abo herausholt, das du ohnehin bezahlst.

> ⭐ **Wenn dir GG Coder Zeit oder Geld spart, gib ihm einen Stern.** So finden andere Entwickler das Projekt am ehesten.

## Warum GG Coder

- **Mehr Arbeit pro Abo.** Der schnellste und sparsamste von 20 Agents, die ich auf demselben Modell gegeneinander antreten ließ. Claude Code verbrauchte für dieselbe Arbeit 169 % mehr.
- **Echter Code statt Raten.** Agent Steroids durchsucht echten, aktuellen Open-Source-Code auf deinem Rechner. Kein MCP-Server mit Rate-Limit, keine Limits.
- **Fertig heißt geprüft.** Ken Autopilot arbeitet weiter, bis alles wirklich verifiziert ist.
- **Sauber veröffentlichen, auch als Einsteiger.** Programmieren ist nur ein Teil. Prüfungen per Klick für Sicherheit, Compliance, Datensicherheit, Barrierefreiheit, Tests und mehr, dazu ein Project-health-Score, damit du nicht wissen musst, wonach du fragen sollst.
- **Deine Abos.** Claude-, ChatGPT-, Kimi-Code-, MiniMax- und MiMo-Pläne, jeder API-Schlüssel oder lokale Modelle.

| Agent              | Zeit für die ganze Suite | Verbrauch pro Suite | Zeit vs. GG Coder | Verbrauch vs. GG Coder |
| ------------------ | ------------------------ | ------------------- | ----------------- | ---------------------- |
| **GG Coder**       | **102 s**                | **$0.014**          |                   |                        |
| Codewhale          | 112 s                    | $0.022              | 10 % langsamer    | 58 % mehr              |
| Goose              | 132 s                    | $0.020              | 29 % langsamer    | 46 % mehr              |
| GitHub Copilot CLI | 136 s                    | $0.025              | 33 % langsamer    | 83 % mehr              |
| Kimi Code          | 138 s                    | $0.024              | 36 % langsamer    | 74 % mehr              |
| Claude Code        | 142 s                    | $0.037              | 39 % langsamer    | 169 % mehr             |
| ForgeCode          | 155 s                    | $0.042              | 52 % langsamer    | 204 % mehr             |
| Dirac              | 160 s                    | $0.029              | 57 % langsamer    | 114 % mehr             |
| Crush              | 165 s                    | $0.037              | 62 % langsamer    | 173 % mehr             |
| Factory Droid      | 167 s                    | $0.025              | 64 % langsamer    | 83 % mehr              |
| Mistral Vibe       | 169 s                    | $0.036              | 66 % langsamer    | 164 % mehr             |
| DeepSeek-Reasonix  | 170 s                    | $0.027              | 67 % langsamer    | 99 % mehr              |
| Oh My Pi           | 170 s                    | $0.031              | 67 % langsamer    | 123 % mehr             |
| Xum                | 172 s                    | $0.041              | 69 % langsamer    | 203 % mehr             |
| Docker Agent       | 173 s                    | $0.021              | 70 % langsamer    | 51 % mehr              |
| Qwen Code          | 177 s                    | $0.049              | 74 % langsamer    | 257 % mehr             |
| Prime Agent        | 190 s                    | $0.029              | 86 % langsamer    | 111 % mehr             |
| Hermes Agent       | 190 s                    | $0.027              | 87 % langsamer    | 100 % mehr             |
| Deep Agents        | 201 s                    | $0.041              | 97 % langsamer    | 198 % mehr             |
| jcode              | 380 s                    | $0.178              | 274 % langsamer   | 1196 % mehr            |

<sub>Tabelle: ein vollständiges Rennen am 4. November 2026. 20 Agents, jeweils in der aktuellen stabilen Version (GG Coder v0.102.0), 7 Aufgaben, je 5 Durchläufe (700 Durchläufe), alle mit Claude Haiku 5.5 und derselben Thinking-Einstellung. Jeder Agent bekam dieselben Prompts und bei jedem Durchlauf eine frische Kopie des Projekts und lief ohne Extras, GG Coder eingeschlossen: nur mit dem eigenen eingebauten Prompt und den eigenen Tools, ohne Skills, Plugins, MCP-Server oder eigene Anweisungen. Die Aufgaben nutzen kleine Testprojekte plus eine Frage zur Codebasis von Vite (v8.3.5), sodass kein Agent an seinem eigenen Code arbeitet. Ein Durchlauf zählt nur, wenn versteckte Tests bestehen oder die Antwort richtig ist.</sub>

## Außerdem dabei

- **GG Goals:** Übergib ein ganzes Ziel, ein Team von Workern zieht es durch.
- **Chat:** Unterhaltungen, die sich an den Kontext erinnern.
- **GG Motion:** macht aus deinen Ideen Videos.

## Loslegen

1. GG Coder installieren:

   **macOS (Apple Silicon):** [Neueste Version herunterladen](https://github.com/KenKaiii/gg-framework/releases/latest) und die `.dmg` öffnen.

   **Windows:** [Neueste Version herunterladen](https://github.com/KenKaiii/gg-framework/releases/latest) und den `.exe`-Installer ausführen.

   **Linux (x86_64):** [Neueste Version herunterladen](https://github.com/KenKaiii/gg-framework/releases/latest) und die `.deb` (`sudo apt install ./GG*.deb`) oder `.rpm` (`sudo dnf install ./GG*.rpm`) installieren.

   **Entwicklung:** Mit installiertem Node.js, pnpm und den [Tauri-Voraussetzungen](https://v2.tauri.app/start/prerequisites/):

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. App öffnen, KI-Anbieter verbinden und Code, Chat oder Motion wählen.

## Mit dem Framework bauen

Du willst die Engine ohne die Desktop-App? Nutze dieselben Pakete in deinen eigenen Apps. Installiere nur, was du brauchst.

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): Mit KI-Anbietern verbinden und Antworten streamen.
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): Agents bauen, die deine Tools nutzen und Aufgaben abarbeiten.
- [**@kenkaiiii/gg-core**](packages/gg-core/README.md): Modellauswahl, Authentifizierung und Erkennung lokaler Modelle.
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): Der Coding-Agent, die Sessions und die Tools hinter App und CLI.

Für deinen eigenen Agent fängst du hier an:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

Die Paket-Links oben erklären Einrichtung und Nutzung. Lizenziert unter AGPL-3.0: Du kannst darauf aufbauen. Wenn du deine Änderungen verbreitest oder als Netzwerkdienst betreibst, gibst du ihren Quellcode unter derselben Lizenz weiter.

## Mitmachen

Bug-Reports, Ideen und Pull Requests sind willkommen. Lies vorher [CONTRIBUTING.md](CONTRIBUTING.md) und den [Verhaltenskodex](CODE_OF_CONDUCT.md).

## Lern mit mir

Bau mit mir in meiner [Skool-Community](https://skool.com/kenkai). Hol dir Hilfe, zeig, woran du arbeitest, und lerne, mehr aus KI herauszuholen.

## Sterne-Verlauf

<a href="https://star-history.com/#KenKaiii/gg-framework&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date&amp;theme=dark">
    <img alt="Sterne-Verlauf von GG Coder" src="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date">
  </picture>
</a>

<p align="center">Wenn GG Coder dir hilft, ⭐ gib dem Repo einen Stern, damit mehr Leute es finden.</p>
