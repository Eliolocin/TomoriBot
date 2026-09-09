---
title: "セットアップ: ローカルLLM"
sidebar:
  order: 1
---

TomoriBotは、テキスト生成や埋め込みに任意のOpenAI互換ローカルLLMサーバーを使用できます。
このガイドでは、最も簡単に始められる**Ollama**を例としてプロセスを説明します。

慣れてきたら、[KoboldCPP](https://github.com/LostRuins/koboldcpp)のようなより柔軟なサーバーを検討し、[Hugging Face](https://huggingface.co)から直接オープンソースモデルを使用してみてください。コミュニティで作成されたさまざまなモデルを選んで試すことは、自分自身のAIを実行する楽しみの半分を占めています。

:::note[環境変数は不要です]
ローカルモデルはDiscordのスラッシュコマンドを通じて登録され、データベースに暗号化されて保存されます。これらを設定する`.env`はありません。[ローカルエンドポイントハブ](/ja/self-hosting/local-endpoints/)を参照してください。
:::

## 1. モデルサーバーを実行する

[Ollama](https://ollama.com)をインストールします。以下の例ではGoogleの**Gemma 4**を使用していますが、[Ollamaのライブラリ](https://ollama.com/library)にあるものであれば何でも機能します。

### どのサイズをプルすべきか？

ローカルモデルは、GPUの**VRAM**（システムRAMとは別の、グラフィックカードに組み込まれたメモリ）で実行されます。経験則として、モデルは少なくとも**ダウンロードサイズ**分の空きVRAMと、会話コンテキスト用に約1〜2 GBのヘッドルームを必要とします。カードに収まる最大のGemma 4を選択してください。

| あなたのGPU VRAM | 最適なサイズ | ダウンロード (約) |
|---|---|---|
| 約 8 GB | `gemma4:e2b` | 7.2 GB |
| 約 12 GB | `gemma4:12b` | 7.6 GB |
| 約 16 GB | `gemma4:12b` (完全に収まる)、または `gemma4:26b` | 7.6 / 18 GB |
| 24 GB 以上 | `gemma4:26b` または `gemma4:31b` | 18 / 20 GB |

ダウンロードサイズはOllamaのデフォルトの量子化サイズです。正確な数値については[モデルページ](https://ollama.com/library/gemma4)を参照してください。VRAMがどれくらいあるかわからない場合は、Windowsの場合：**タスクマネージャー → パフォーマンス → GPU**で「専用GPUメモリ」を確認してください。

:::tip[26Bがサイズ以上の性能を発揮できる理由]
`gemma4:26b`は**Mixture-of-Experts (MoE)**モデルです。多くの「エキスパート」サブネットワークを保持していますが、トークンごとにアクティブになるパラメーターは約4Bのみです。そのため、約18 GBの重みが16 GBに*完全に*収まらなくても、同じフットプリントの密なモデルとは異なり、システムRAMへのわずかなあふれはほとんど速度を低下させません。これが、多くの16 GBカードで快適に動作する理由です。
:::

選択したサイズをプルし、サーバーを起動します。

```sh
ollama pull gemma4:12b     # swap for the tag that fits your VRAM
ollama serve               # listens on http://127.0.0.1:11434
```

**TomoriBotが実行されているマシンから**到達可能であることを確認してください。

```sh
curl http://127.0.0.1:11434/v1/models
```

登録するModel Nameとなるため、インストールされている正確なタグをメモしておきます。

```sh
ollama list
# NAME              ID            SIZE
# gemma4:12b        a1b2c3d4...   7.6 GB
```

## 2. Discordに登録する

**`/providers`**（サーバー全体）または**`/personal providers`**（自分のみ）で **Add New Custom Endpoint** を選び、以下を入力します。

| フィールド | Ollama用の値 |
|-------|------------------|
| `endpoint_label` | 選択した名前（例: `home-ollama`） |
| API Compatibility | `OpenAI-Compatible`（推奨）または `Ollama` |
| `endpoint_url` | OpenAI-Compatibleの場合は `http://127.0.0.1:11434/v1` · Ollamaの場合は `http://127.0.0.1:11434` |
| `auth_token` | *(空白のままにします)* |

:::tip[API Compatibilityに一致するURLを選択する]
`OpenAI-Compatible`と`Ollama`はどちらも`/v1`のないルートを受け入れ、`/v1`ベースに正規化されます。`/chat/completions`は自動的に追加されるため、**追加しない**でください。`https://openrouter.ai/api/v1`やゲートウェイのプレフィックスなど、すでにパスを含むURLはそのまま保存されます。
:::

保存したエンドポイントを選択し、**Add or Edit a Model** で新しいテキストモデルに以下を入力します。

- **Model Name (exact API ID):** `gemma4:12b`、`ollama list`で確認した正確なタグ。
- **Context Window Override:** オプション、**Ollama / KoboldCPPのみ**。これ（例: `8192`、`16384`）を設定してOllamaのデフォルトの`num_ctx`を上げます。設定しないと、TomoriBotの長いコンテキストが切り捨てられるほど小さくなります。サーバーのデフォルトを使用する場合は空白のままにします。
- **Toggles:** モデルが関数呼び出しをサポートしている場合は**Tools**を有効にします。ビジョンモデルの場合のみ**Image Understanding**を有効にし、モデルがJSONスキーマを適切に処理する場合は**Structured Output**を有効にします。この例のGemma 4はこれらすべてをサポートしているため、すべてにチェックを入れます。

TomoriBotは送信時に接続を検証します。エンドポイントに到達できないと報告された場合、通常の原因は`localhost`/Dockerの不一致、または欠落/余分な`/v1`です（[注意事項と落とし穴](#注意事項と落とし穴)を参照）。

登録すると自動的にアクティブな`text`モデルになります。チャットを始めて試してみてください。何らかの理由でアクティブにならない場合は、`/config` > Models > Switch Modelsを実行し、新しく登録したモデルを選択します。

## 3. (オプション) RAG用のローカル埋め込み

保存したエンドポイントを選択し、**Add or Edit a Model** で埋め込みモデル（例: `ollama pull nomic-embed-text`、Model Name `nomic-embed-text:latest`）を追加します。RAG機能にはPostgresにpgvectorがインストールされている必要もあります。ここで[手動セットアップ](/ja/self-hosting/manual-setup/)ガイドを確認できます。

## その他のサーバー

これらはすべて同じフローを使用し、URLといくつかの注意事項のみが異なります。

### KoboldCPP

- OpenAI互換を有効にして（組み込み）起動します。デフォルト: `http://127.0.0.1:5001/v1`。
- API Compatibility: `OpenAI-Compatible`。`endpoint_url`: `http://127.0.0.1:5001/v1`。
- Ollamaのように**Context Window Override**を尊重します。
- GGUFモデルを読み込みます。Model Nameは、読み込まれたモデルが報告するもの（多くの場合ファイル名）です。KoboldCPPの`/v1/models`レスポンスを確認してください。

### llama.cpp (`llama-server`)

- [llama.cpp](https://github.com/ggml-org/llama.cpp)をビルドまたはインストールし、バンドルされているOpenAI互換サーバーでGGUFを提供します。
  ```sh
  llama-server -m model.gguf -c 16384 --host 0.0.0.0 --port 8080
  ```
- API Compatibility: `OpenAI-Compatible`。`endpoint_url`: `http://127.0.0.1:8080/v1`。
- `-c`を使用して起動時にコンテキストウィンドウを設定します。モーダルの**Context Window Override**はOllama/KoboldCPP専用であり、ここでは効果がありません。
- Model Nameは`/v1/models`が報告するものです。`--alias my-model`できれいな名前を付けてください。
- `--api-key`で起動した場合は、そのキーを`auth_token`に入力します。

### LM Studio

- LM Studioで、**Local Server**（Developerタブ）を起動します。デフォルト: `http://127.0.0.1:1234/v1`。
- API Compatibility: `OpenAI-Compatible`。`endpoint_url`: `http://127.0.0.1:1234/v1`。
- Model Nameは、読み込まれたモデルに対してLM Studioが表示する識別子です。

### vLLM

- OpenAI互換サーバーで提供します: `vllm serve <model>` → `http://127.0.0.1:8000/v1`。
- API Compatibility: `OpenAI-Compatible`。`endpoint_url`: `http://127.0.0.1:8000/v1`。
- `--api-key`でvLLMを起動した場合は、そのキーを`auth_token`に入力します。
- Model Nameは、提供されるモデルのパス/名前です（`/v1/models`と一致します）。

### LiteLLM (複数のバックエンドに対するプロキシ)

- LiteLLMプロキシを実行します。デフォルト: `http://127.0.0.1:4000/v1`。
- API Compatibility: `OpenAI-Compatible`。`endpoint_url`: `http://127.0.0.1:4000/v1`。
- Model Nameは、LiteLLMの設定で定義したモデルエイリアスです。
- プロキシがマスターキーを強制する場合は、それを`auth_token`に設定します。

### ChatMock (ChatGPTアカウント / Codex CLI)

システムプロンプトの回避策があるため、独自の専用ガイドがあります:
**[セットアップ: ChatMock](/ja/self-hosting/local-endpoints/setup-chatmock/)**。

## Hugging Faceからのモデルの選択

Ollamaの厳選されたライブラリに加えて、[Hugging Face](https://huggingface.co)は数千のコミュニティモデルをホストしています。KoboldCPP、llama.cpp、LM Studioはすべて**GGUF**フォーマットを読み込むことができます。これは、ダウンロードしてサーバーに向ける単一ファイルのパッケージです。

1. **GGUFを見つける。** Hugging Faceで目的のモデルと「GGUF」を検索します。[bartowski](https://huggingface.co/bartowski)のようなコミュニティクオンタイザーは、リリース後すぐに最も人気のあるモデルのGGUFビルドを公開します。**instruct/chat**バリアント（`-Instruct`または`-Chat`で終わる名前）を優先してください。ベースモデルでは会話が成り立ちません。
2. **VRAMに収まる量子化を選択する。** リポジトリには同じモデルの多くの量子化レベルがリストされており、ファイルサイズ ≈ 必要なVRAM（プラス、コンテキスト用の約1〜2 GB。上記の[サイズ表](#どのサイズをプルすべきか)のルールと同じ）です。選択した単一の`.gguf`をダウンロードします。
3. **読み込む。** そのファイルでKoboldCPPまたは`llama-server`を起動し（[その他のサーバー](#その他のサーバー)を参照）、通常通りDiscordでエンドポイントを登録します。

:::tip[どの量子化？Q4またはQ5がスイートスポット]
**量子化**は各重みをより少ないビット数で保存し、わずかな品質コストでモデルを縮小します。`Q4_K_M`や`Q5_K_M`のような名前のコードは重みあたりのビット数です。**4ビット（Q4）または5ビット（Q5）が通常のスイートスポット**であり、8ビットの約半分のサイズで品質のほとんどを維持します。4ビット未満にすると急速に劣化します。また、固定のVRAM予算では、通常、**Q4のより大きなモデルの方がQ8のより小さなモデルよりも優れています**。
:::

## 注意事項と落とし穴

- **ラベルごとに1つのエンドポイント項目。** 1つのサーバーを共有する複数のモデルを登録するには、保存したエンドポイントを選び、**Add or Edit a Model** を再度使用します。異なるサーバーまたはAPIプロトコルには別々のラベルを使用してください。
- **Model NameはAPI識別子です。** サーバーに送信される正確な文字列なので、間違えると「接続できたがレスポンスに失敗する」原因になります。
- **TomoriBotをDockerで実行している場合:** コンテナ内の`localhost`はホストではありません。`http://host.docker.internal:<port>`（Windows/macOS）またはホストのLAN IPを使用し、モデルサーバーを`0.0.0.0`にバインドしてください。
