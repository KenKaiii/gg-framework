<p align="center">
  <img src="gg-app/icon-source.png" alt="GG Coder app icon" width="128">
</p>

<p align="center">
  <img src="docs/art/home.png" alt="GG Coder desktop home screen">
</p>

<p align="center">
  <strong>다른 에이전트들이 너무 짜증 나서 만들었습니다.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <strong>한국어</strong> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/gg-framework?style=for-the-badge&label=Download&color=b0b6ff" alt="GG Coder desktop release"></a>
  <a href="https://github.com/KenKaiii/gg-framework"><img src="https://img.shields.io/github/stars/KenKaiii/gg-framework?style=for-the-badge&label=Stars&color=yellow" alt="Star GG Coder on GitHub"></a>
  <a href="https://github.com/KenKaiii/gg-framework/releases"><img src="https://img.shields.io/github/downloads/KenKaiii/gg-framework/total?style=for-the-badge&label=App%20downloads&color=2ecc71" alt="Desktop app downloads"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/dm/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI%20downloads&color=2ecc71" alt="ggcoder npm downloads per month"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI&color=blue" alt="ggcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://www.skool.com/raid"><img src="https://img.shields.io/badge/Skool-Free%20community-b0b6ff?style=for-the-badge" alt="Free Skool community"></a>
</p>

<sub>이 페이지는 번역본이라 영어판보다 업데이트가 늦을 수 있습니다. 내용이 다르면 [English README](README.md)가 우선합니다.</sub>

GG Coder는 이미 결제하고 있는 AI 구독을 더 알차게 쓰게 해 주는 데스크톱 코딩 에이전트입니다.

> ⭐ **GG Coder로 시간이나 비용을 아꼈다면 Star를 눌러 주세요.** 다른 개발자들이 GG Coder를 찾는 가장 큰 경로입니다.

## GG Coder를 써야 하는 이유

- **같은 요금제로 더 많은 작업을.** 같은 모델로 20개 에이전트를 경주시킨 결과 가장 빠르고 가장 적게 썼습니다. 같은 작업에 Claude Code는 169% 더 많이 썼습니다.
- **추측이 아닌 실제 코드.** Agent Steroids는 내 컴퓨터에서 실제 최신 오픈소스 코드를 검색합니다. 속도 제한이 걸린 MCP 서버도, 사용 한도도 없습니다.
- **완료는 곧 검증 완료.** Ken Autopilot은 실제로 검증될 때까지 작업을 계속합니다.
- **초보자도 제대로 출시.** 코딩은 일의 일부일 뿐입니다. 보안, 컴플라이언스, 데이터 안전, 접근성, 테스트 등을 클릭 한 번으로 점검하고 Project health 점수까지 제공하니, 무엇을 요청해야 할지 몰라도 됩니다.
- **내 구독 그대로.** Claude, ChatGPT, Kimi Code, MiniMax, MiMo 플랜, 모든 API 키 또는 로컬 모델.

| 에이전트           | 전체 작업 소요 시간 | 작업 세트당 사용량 | 시간 (GG Coder 대비) | 사용량 (GG Coder 대비) |
| ------------------ | ------------------- | ------------------ | -------------------- | ---------------------- |
| **GG Coder**       | **102 s**           | **$0.014**         |                      |                        |
| Codewhale          | 112 s               | $0.022             | 10% 느림             | 58% 더 많음            |
| Goose              | 132 s               | $0.020             | 29% 느림             | 46% 더 많음            |
| GitHub Copilot CLI | 136 s               | $0.025             | 33% 느림             | 83% 더 많음            |
| Kimi Code          | 138 s               | $0.024             | 36% 느림             | 74% 더 많음            |
| Claude Code        | 142 s               | $0.037             | 39% 느림             | 169% 더 많음           |
| ForgeCode          | 155 s               | $0.042             | 52% 느림             | 204% 더 많음           |
| Dirac              | 160 s               | $0.029             | 57% 느림             | 114% 더 많음           |
| Crush              | 165 s               | $0.037             | 62% 느림             | 173% 더 많음           |
| Factory Droid      | 167 s               | $0.025             | 64% 느림             | 83% 더 많음            |
| Mistral Vibe       | 169 s               | $0.036             | 66% 느림             | 164% 더 많음           |
| DeepSeek-Reasonix  | 170 s               | $0.027             | 67% 느림             | 99% 더 많음            |
| Oh My Pi           | 170 s               | $0.031             | 67% 느림             | 123% 더 많음           |
| Xum                | 172 s               | $0.041             | 69% 느림             | 203% 더 많음           |
| Docker Agent       | 173 s               | $0.021             | 70% 느림             | 51% 더 많음            |
| Qwen Code          | 177 s               | $0.049             | 74% 느림             | 257% 더 많음           |
| Prime Agent        | 190 s               | $0.029             | 86% 느림             | 111% 더 많음           |
| Hermes Agent       | 190 s               | $0.027             | 87% 느림             | 100% 더 많음           |
| Deep Agents        | 201 s               | $0.041             | 97% 느림             | 198% 더 많음           |
| jcode              | 380 s               | $0.178             | 274% 느림            | 1196% 더 많음          |

<sub>표: 2026년 11월 4일에 진행한 한 번의 전체 경주. 20개 에이전트(모두 현재 안정 버전, GG Coder는 v0.102.0), 7개 작업, 작업당 5회(총 700회) 실행했으며 모두 Claude Haiku 5.5와 같은 사고(thinking) 설정을 사용했습니다. 모든 에이전트가 같은 프롬프트를 받았고 매번 새 프로젝트 사본에서 실행했으며, GG Coder를 포함해 기본 상태로 실행했습니다. 즉 자체 내장 프롬프트와 도구만 사용하고 스킬, 플러그인, MCP 서버, 사용자 지정 지침은 없었습니다. 작업은 작은 테스트 프로젝트와 Vite 코드베이스(v8.3.5)에 대한 질문 하나로 구성되어, 어떤 에이전트도 자기 코드를 다루지 않습니다. 숨겨진 테스트를 통과하거나 답이 맞은 경우에만 성공으로 집계했습니다.</sub>

## 함께 제공되는 기능

- **GG Goals:** 목표 전체를 맡기면 워커 팀이 끝까지 해냅니다.
- **Chat:** 맥락을 기억하는 대화.
- **GG Motion:** 아이디어를 영상으로 만들어 줍니다.

## 시작하기

1. GG Coder 설치:

   **macOS (Apple Silicon):** [최신 릴리스를 다운로드](https://github.com/KenKaiii/gg-framework/releases/latest)하고 `.dmg`를 엽니다.

   **Windows:** [최신 릴리스를 다운로드](https://github.com/KenKaiii/gg-framework/releases/latest)하고 `.exe` 설치 프로그램을 실행합니다.

   **Linux (x86_64):** [최신 릴리스를 다운로드](https://github.com/KenKaiii/gg-framework/releases/latest)하고 `.deb`(`sudo apt install ./GG*.deb`) 또는 `.rpm`(`sudo dnf install ./GG*.rpm`)을 설치합니다.

   **개발:** Node.js, pnpm, [Tauri 사전 요구 사항](https://v2.tauri.app/start/prerequisites/)을 설치한 뒤:

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. 앱을 열고 AI 제공자를 연결한 다음 Code, Chat, Motion 중 하나를 선택합니다.

## 프레임워크로 개발하기

데스크톱 앱 없이 엔진만 필요하신가요? 같은 패키지를 내 앱에서 사용하세요. 필요한 것만 설치하면 됩니다.

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): AI 제공자에 연결하고 응답을 스트리밍합니다.
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): 내 도구를 사용해 작업을 해결하는 에이전트를 만듭니다.
- [**@kenkaiiii/gg-core**](packages/gg-core/README.md): 모델 선택, 인증, 로컬 모델 검색.
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): 앱과 CLI를 구동하는 코딩 에이전트, 세션, 도구.

나만의 에이전트는 여기서 시작하세요:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

설정과 사용법은 위 패키지 링크에 있습니다. AGPL-3.0 라이선스: 이를 기반으로 자유롭게 개발할 수 있으며, 변경 사항을 배포하거나 네트워크 서비스로 운영한다면 같은 라이선스로 해당 소스 코드를 공개해야 합니다.

## 기여하기

버그 신고, 아이디어, 풀 리퀘스트 모두 환영합니다. 시작하기 전에 [CONTRIBUTING.md](CONTRIBUTING.md)와 [행동 강령](CODE_OF_CONDUCT.md)을 읽어 주세요.

## 함께 배워요

제 [Skool 커뮤니티](https://www.skool.com/raid)에서 함께 만들어요. 도움을 받고, 만든 것을 공유하고, AI를 더 잘 활용하는 방법을 배울 수 있습니다.

## Star 기록

<a href="https://star-history.com/#KenKaiii/gg-framework&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date&amp;theme=dark">
    <img alt="GG Coder Star 기록 차트" src="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date">
  </picture>
</a>

<p align="center">GG Coder가 유용했다면 ⭐ Star를 눌러 더 많은 사람이 찾을 수 있게 해 주세요.</p>
