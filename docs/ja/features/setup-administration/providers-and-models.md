---
title: "プロバイダーとモデル"
sidebar:
  order: 1
---

TomoriBotには組み込みのAIの脳はありません。ご自身で接続する必要があります。**プロバイダー**とはAIサービス（Google Gemini、OpenRouter、NovelAI、ローカルエンドポイントなど）のことであり、**モデル**はそのプロバイダー上の特定のモデルを指します。トモリを利用するには、少なくとも1つのプロバイダーが必要です。

## APIキー

初回のセットアップ時に`/setup`でプロバイダーのキーを追加するか、後から`/providers`で追加します。キーは**保存時に暗号化**されるため、サーバー管理者を含め、誰も読み取ることはできません。

各プロバイダーには独自のキー生成手順があります。正確な手順を確認するには、**`/help`**を実行し、**セットアップ**、**ステップ1：APIキーを取得** の順に開いてプロバイダーを選択するか、以下の開始点を参照してください。

| プロバイダー | メモ | キーの取得 |
|---|---|---|
| **Google Gemini** | 無料枠あり、全機能が動作。最初のセットアップにおすすめ。 | [AI Studio](https://aistudio.google.com/apikey) |
| **OpenRouter** | 1つのキーで多数のモデルを利用（一部無料）。 | [OpenRouter keys](https://openrouter.ai/settings/keys) |
| **NovelAI** | サブスクリプション。無修正のストーリーテリング・ロールプレイ（テキストのみ）。 | [NovelAI](https://novelai.net/) |
| **DeepSeek** | 従量課金制の推論モデル。 | [DeepSeek](https://platform.deepseek.com/api_keys) |
| **NVIDIA NIM** | ホスト型のテキスト、埋め込み、および画像。 | [NVIDIA Build](https://build.nvidia.com/) |
| **Anthropic** | API経由のClaudeモデル（Claude Codeではありません）。 | — |
| **Z.ai** | GLMファミリー。⚠️ 利用規約によりコーディング・エージェントのシナリオに限定。 | [Z.ai](https://z.ai/) |
| **Vertex AI** | `gcloud` ADC経由のGoogle Cloud。ローカル実行や開発用セットアップに最適。 | 下記参照 |
| **Vertex AI Express** | Google Cloud APIキーのBYOK（プレビュー版、Geminiのサブセット）。 | [Express Mode](https://console.cloud.google.com/expressmode) |
| **カスタム** | 任意のOpenAI互換エンドポイント（Ollama、vLLM、LiteLLMなど）。 | [カスタムエンドポイント](#custom-endpoints)を参照 |

:::caution
APIキーは絶対に他人と共有しないでください。カスタムエンドポイントでは、`/providers`でセットアップした後にBearer認証トークンを追加できます。
:::

**Vertex AI**は、保存されたシークレットではなくアプリケーションのデフォルト認証情報（Application Default Credentials）で認証を行うため、短い`gcloud` CLIの設定が必要です。詳細な手順は`/help`の **APIキー** ページで **Google Vertex AI** を選ぶと確認できます。⚠️ `gen-lang-client-`で始まるプロジェクト（AI Studioで自動作成されたもの）はVertexでは動作しません。適切なプロジェクトを作成してください。

### オプション：Brave Searchキー

Brave SearchはAIプロバイダーとは別であり、ウェブ検索を強化するだけのものです（画像、動画、ニュースの検索を追加します）。`/providers`で設定します。⚠️ Braveには月額5ドルの無料クレジットが含まれています。料金の発生を防ぐため、Braveのダッシュボードで5ドルの利用制限を設定してください。

## モデルの選択

`/providers`と`/model`は**サーバースコープ**です。このサーバーの全員が使う共通の既定を設定するもので、実行には必要なサーバー権限が要ります。個々のメンバーは`/personal providers`で自分自身のリクエスト用に既定を上書きでき、その設定はTomoriBotを使うすべてのサーバーに引き継がれます。詳しくは[パーソナライゼーション](/ja/features/knowledge/personalization/#個人のプロバイダー)を参照してください。

プロバイダーを設定した後、このサーバーの各機能で使用するモデルを選択します。

- `/config` > Models > Switch Models：メインのチャットモデル
- `/config` > Models > Switch Models：ビジョンモデル（チャットモデルが画像を読み取れない場合に画像を読み取るため）
- `/config` > Models > Switch Models：画像生成（[画像生成](/ja/features/capabilities/media-generation/image-generation/)を参照）
- `/config` > Models > Switch Models：動画生成
- `/config` > Models > Switch Models：[ドキュメントナレッジベース](/ja/features/knowledge/memory/#document-knowledge-base-rag)用の埋め込み（embeddings）
- `/providers` / `/providers`：[音声](/ja/features/capabilities/media-generation/tts-and-stt/)

また、`/providers`を使用して、このサーバーの自動フェイルオーバーと負荷分散用のバックアップキーを管理することもできます。

## カスタムエンドポイント

カスタムエンドポイントを使用すると、セルフホストまたはプロキシベースのサービス（Ollama、LM Studio、LiteLLM、vLLM、ComfyUI、ローカルのTTS/STTなど）を**ラベル付きのプロバイダーバンドル**として登録できます。

- **サーバー全体：** `/providers` / `remove`。
- **個人用：** `/personal providers` / `remove`（あなた専用です。[パーソナライゼーション](/ja/features/knowledge/personalization/#your-own-providers)を参照）。

**ラベル**はユーザー向けメニューに表示される名前で、同じエンドポイントURLを使用する機能を1つのバンドルにグループ化します。リモートエンドポイントには送信されません。異なるURLから提供される機能には、別々のラベルが必要です。**Add New Custom Endpoint**でAPI Compatibility（API互換性）を選ぶと、そのプロトコルが対応する機能の接続がモデル未登録の状態で作成されます。その後、新しいエンドポイントを選択し、**Add or Edit a Model**で機能と正確なモデルコードを登録します。モデルを追加すると、その機能で直ちに有効になります。API Compatibilityは使用するリクエストパスとペイロード形式を指定するものであり、モデルの機能とは独立しています。

サーバーの実行に関する完全な手順については、以下をご覧ください。

- [セットアップ：ローカルLLM](/ja/self-hosting/local-endpoints/setup-local-llm/)：Ollama、KoboldCPP、LM Studio、vLLM、LiteLLM。
- [セットアップ：ComfyUI](/ja/self-hosting/local-endpoints/setup-comfyui/)：ローカルの画像・動画生成。
- [セットアップ：ChatMock](/ja/self-hosting/local-endpoints/setup-chatmock/)：ChatGPTアカウント / Codex CLI。

## サポートされているプロバイダー

モデルをホストするためのハードウェアがない場合でも、TomoriBotは幅広いサービスをサポートしています。すべての機能がすべてのプロバイダーで利用できるわけではありません。

### LLMプロバイダー

| プロバイダー | ストリーミング | ツール呼び出し | 画像入力 | 埋め込み | メモ |
|---|---|---|---|---|---|
| **Google Gemini** | ✅ | ✅ | ✅ | ✅ | 無料モデルあり |
| **OpenRouter** | ✅ | ✅ | ✅ | ✅ | 無料モデルあり |
| **Anthropic (API)** | ✅ | ✅ | ✅ | – | Claude Codeではありません |
| **NovelAI** | ✅ | ✅ | – | – | GLM 4.6のみツールを使用可能 |
| **NVIDIA NIM** | ✅ | ✅ | ✅ | ✅ | 無料モデルあり |
| **DeepSeek** | ✅ | ✅ | – | – | – |
| **Z.ai** | ✅ | ✅ | ✅ | – | 無料モデルあり。⚠️ 利用規約 = コーディング・エージェント使用のみ |
| **Z.ai Coding** | ✅ | ✅ | – | – | サブスクリプションプラン |
| **Google Vertex AI** | ✅ | ✅ | ✅ | ✅ | 「無料」のExpress版を含む |
| **Codex CLI (ChatMock経由)** | ✅ | ✅ | ✅ | – | [セットアップ](/ja/self-hosting/local-endpoints/setup-chatmock/) |

### 画像生成

| プロバイダー | テキストからの画像生成 | 画像からの画像生成 | インペインティング | メモ |
|---|---|---|---|---|
| **Google** | ✅ | ✅ | – | – |
| **OpenRouter** | ✅ | ✅ | – | – |
| **NovelAI** | ✅ | ✅ | ✅ | 他のプロバイダーと組み合わせ可能 |
| **NVIDIA** | ✅ | – | – | テキストから画像のみ。参照画像は無視されます |
| **Z.ai** | ✅ | – | – | – |

### 動画生成

| プロバイダー | テキストからの動画生成 | 画像からの動画生成 | メモ |
|---|---|---|---|
| **Google** | ✅ | ✅ | 非同期のポーリングワークフロー |
| **OpenRouter** | ✅ | ✅ | 非同期のポーリングワークフロー |
| **Z.ai** | ✅ | ✅ | 非同期のポーリングワークフロー |

### 音声とオーディオ

| プロバイダー | テキストからの音声生成 | 音声からテキストへの変換 |
|---|---|---|
| **ElevenLabs** | ✅ | ✅ |

ローカルの音声エンジンについては、[セルフホスト](/ja/self-hosting/)で説明されています。組み込みのウェブ検索およびURL取得エンジンについては、[ツールと拡張機能](/ja/features/capabilities/tools-and-extensions/#web-search--url-reading)をご覧ください。
