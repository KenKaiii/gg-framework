<p align="center">
  <img src="gg-app/icon-source.png" alt="GG Coder app icon" width="128">
</p>

<p align="center">
  <img src="docs/art/home.png" alt="GG Coder desktop home screen">
</p>

<p align="center">
  <strong>他のエージェントにイライラしたから。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <strong>日本語</strong> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a>
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

<sub>このページは翻訳版のため、英語版より更新が遅れる場合があります。内容に違いがある場合は [English README](README.md) が優先されます。</sub>

GG Coder は、すでに払っている AI サブスクリプションからより多くを引き出すデスクトップ向けコーディングエージェントです。

> ⭐ **GG Coder で時間やお金を節約できたら、ぜひスターをお願いします。** 他の開発者が GG Coder を見つける一番のきっかけになります。

## GG Coder を選ぶ理由

- **同じプランで、もっと多くの作業を。** 同じモデルで 20 のエージェントを競わせた中で、最も速く、最も無駄がありませんでした。同じ作業で Claude Code は 169% 多く使いました。
- **推測ではなく、実際のコード。** Agent Steroids は、あなたのマシン上で最新の実際のオープンソースコードを検索します。レート制限のある MCP サーバーも、利用上限もありません。
- **「完了」は検証済みという意味。** Ken Autopilot は、本当に検証が通るまで作業を続けます。
- **初心者でも、きちんとリリース。** コーディングは仕事の一部にすぎません。セキュリティ、コンプライアンス、データ保護、アクセシビリティ、テストなどをワンクリックでチェックでき、Project health スコアも付くので、何を頼めばいいか知らなくても大丈夫です。
- **お手持ちのサブスクリプションで。** Claude、ChatGPT、Kimi Code、MiniMax、MiMo のプラン、各種 API キー、ローカルモデルに対応。

| エージェント       | 全タスクの所要時間 | 1 セットあたりの使用量 | 時間（GG Coder 比） | 使用量（GG Coder 比） |
| ------------------ | ------------------ | ---------------------- | ------------------- | --------------------- |
| **GG Coder**       | **102 s**          | **$0.014**             |                     |                       |
| Codewhale          | 112 s              | $0.022                 | 10% 遅い            | 58% 多い              |
| Goose              | 132 s              | $0.020                 | 29% 遅い            | 46% 多い              |
| GitHub Copilot CLI | 136 s              | $0.025                 | 33% 遅い            | 83% 多い              |
| Kimi Code          | 138 s              | $0.024                 | 36% 遅い            | 74% 多い              |
| Claude Code        | 142 s              | $0.037                 | 39% 遅い            | 169% 多い             |
| ForgeCode          | 155 s              | $0.042                 | 52% 遅い            | 204% 多い             |
| Dirac              | 160 s              | $0.029                 | 57% 遅い            | 114% 多い             |
| Crush              | 165 s              | $0.037                 | 62% 遅い            | 173% 多い             |
| Factory Droid      | 167 s              | $0.025                 | 64% 遅い            | 83% 多い              |
| Mistral Vibe       | 169 s              | $0.036                 | 66% 遅い            | 164% 多い             |
| DeepSeek-Reasonix  | 170 s              | $0.027                 | 67% 遅い            | 99% 多い              |
| Oh My Pi           | 170 s              | $0.031                 | 67% 遅い            | 123% 多い             |
| Xum                | 172 s              | $0.041                 | 69% 遅い            | 203% 多い             |
| Docker Agent       | 173 s              | $0.021                 | 70% 遅い            | 51% 多い              |
| Qwen Code          | 177 s              | $0.049                 | 74% 遅い            | 257% 多い             |
| Prime Agent        | 190 s              | $0.029                 | 86% 遅い            | 111% 多い             |
| Hermes Agent       | 190 s              | $0.027                 | 87% 遅い            | 100% 多い             |
| Deep Agents        | 201 s              | $0.041                 | 97% 遅い            | 198% 多い             |
| jcode              | 380 s              | $0.178                 | 274% 遅い           | 1196% 多い            |

<sub>表：2026 年 11 月 4 日に行った 1 回の完全なレース。20 のエージェント（いずれも現行の安定版、GG Coder は v0.102.0）、7 タスク、各 5 回（計 700 回）、すべて Claude Haiku 5.5 で同じ思考設定。各エージェントには同じプロンプトを与え、毎回プロジェクトの新しいコピーを使い、GG Coder も含めて素の状態で実行しました。つまり組み込みのプロンプトとツールのみで、スキル、プラグイン、MCP サーバー、カスタム指示はなしです。タスクは小さなテストプロジェクトと、Vite のコードベース（v8.3.5）に関する質問 1 つなので、自分自身のコードを扱うエージェントはありません。隠しテストに合格するか、回答が正しい場合のみ成功とカウントしています。</sub>

## その他の機能

- **GG Goals：** 目標をまるごと任せれば、ワーカーのチームが最後までやり遂げます。
- **Chat：** 文脈を覚えている会話。
- **GG Motion：** アイデアを動画にします。

## はじめに

1. GG Coder をインストールします：

   **macOS（Apple Silicon）：** [最新リリースをダウンロード](https://github.com/KenKaiii/gg-framework/releases/latest)して `.dmg` を開きます。

   **Windows：** [最新リリースをダウンロード](https://github.com/KenKaiii/gg-framework/releases/latest)して `.exe` インストーラーを実行します。

   **Linux（x86_64）：** [最新リリースをダウンロード](https://github.com/KenKaiii/gg-framework/releases/latest)して `.deb`（`sudo apt install ./GG*.deb`）または `.rpm`（`sudo dnf install ./GG*.rpm`）をインストールします。

   **開発：** Node.js、pnpm、[Tauri の前提条件](https://v2.tauri.app/start/prerequisites/)をインストールした上で：

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. アプリを開き、AI プロバイダーを接続して、Code、Chat、Motion のいずれかを選びます。

## フレームワークで開発する

デスクトップアプリなしでエンジンだけ使いたいですか？同じパッケージを自分のアプリで使えます。必要なものだけインストールしてください。

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): AI プロバイダーに接続し、レスポンスをストリーミングします。
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): あなたのツールを使ってタスクをこなすエージェントを構築します。
- [**@kenkaiiii/gg-core**](packages/gg-core/README.md): モデル選択、認証、ローカルモデルの検出。
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): アプリと CLI を支えるコーディングエージェント、セッション、ツール。

自分のエージェントを作るなら、ここから：

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

セットアップと使い方は上記の各パッケージのリンクにあります。ライセンスは AGPL-3.0 です。自由にこれをベースに開発できますが、変更を配布したりネットワークサービスとして運用したりする場合は、同じライセンスでそのソースコードを公開してください。

## コントリビュート

バグ報告、アイデア、プルリクエストを歓迎します。始める前に [CONTRIBUTING.md](CONTRIBUTING.md) と[行動規範](CODE_OF_CONDUCT.md)をお読みください。

## 一緒に学ぼう

[Skool コミュニティ](https://www.skool.com/raid)で一緒に作りましょう。サポートを受けたり、作ったものを共有したり、AI をもっと活用する方法を学べます。

## スター履歴

<a href="https://star-history.com/#KenKaiii/gg-framework&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date&amp;theme=dark">
    <img alt="GG Coder スター履歴グラフ" src="https://api.star-history.com/svg?repos=KenKaiii/gg-framework&amp;type=Date">
  </picture>
</a>

<p align="center">GG Coder が役に立ったら、⭐ スターを付けて、もっと多くの人に届けてください。</p>
