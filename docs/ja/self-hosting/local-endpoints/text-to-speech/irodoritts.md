---
title: "IrodoriTTS"
---

Irodori-TTS 500M v2は、日本語に特化したボイスクローニングTTSモデルです。`servers/tts/irodoritts/`にあるローカルFastAPIラッパーサーバーを介して実行されます。

## セットアップ

TomoriBotのリポジトリのルート（TomoriBotをクローンしたフォルダー）から以下のコマンドを実行します（OSによって異なります）。

### Windows PowerShellを使用する場合

```powershell
# 1. エンジンフォルダー内にvenvを作成して有効化
python -m venv servers\tts\irodoritts\.venv
servers\tts\irodoritts\.venv\Scripts\Activate.ps1

# 2. pipをアップグレード
python -m pip install -U pip

# 3. サーバー実行時の依存関係（FastAPI、uvicorn、PyTorch）をインストール
pip install -r servers\tts\irodoritts\requirements.txt

# 4. (GPUのみ) CUDA対応のPyTorchを再インストール - CPUのみのインストールの場合はスキップ
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# 5. パッチスクリプトを介してソースからirodori-ttsをインストール
.\servers\tts\irodoritts\install-irodori.ps1

# 6. サーバーを起動
python servers\tts\irodoritts\server.py
```

### Linux/macOS Bashを使用する場合

```bash
# 1. エンジンフォルダー内にvenvを作成して有効化
python3 -m venv servers/tts/irodoritts/.venv
source servers/tts/irodoritts/.venv/bin/activate

# 2. pipをアップグレード
python -m pip install -U pip

# 3. サーバー実行時の依存関係（FastAPI、uvicorn、PyTorch）をインストール
python -m pip install -r servers/tts/irodoritts/requirements.txt

# 4. (LinuxのGPUのみ) CUDA対応のPyTorchを再インストール - CPUのみのインストールの場合はスキップ
python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# 5. パッチスクリプトを介してソースからirodori-ttsをインストール
bash servers/tts/irodoritts/install-irodori.sh

# 6. サーバーを起動
python servers/tts/irodoritts/server.py
```

> **CUDAバージョン**: ドライバーが古いツールキットを対象としている場合は、`cu124`を`cu118`または`cu121`に置き換えてください。

TomoriBotがIrodoriTTSを使用している間は、そのターミナルを開いたままにしてください。デフォルトのエンドポイントURLは`http://127.0.0.1:8013`です。

## TomoriBotへの登録

`/providers`で **Add New Custom Endpoint** を選びます。

- API Compatibility: `tts-clone`
- `endpoint_url`: `http://127.0.0.1:8013`

保存したエンドポイントを選択し、**Add or Edit a Model** で新しい音声モデルに以下を設定します。

- `Voice Source Mode`: `Clone`
- `Script Markup Style`: `Emoji`

登録すると、エンドポイントはすぐに有効になります。今後、speechエンドポイントを切り替える場合にのみ`/providers`を使用します。

## ペルソナ音声のセットアップ

1. 背景音楽のない、1人の話者による10〜20秒のクリアな日本語の音声クリップを準備します。
2. `/config`を実行してクリップをアップロードします。
3. `/speech voice-assign`を実行し、ペルソナと音声サンプルを選択します。

TomoriBotは、テキストをTTSに送信する前にDiscordのカスタム絵文字構文を削除します。`script_markup: emoji`を設定すると、IrodoriTTSの感情制御用にUnicode絵文字が保持されます。他のspeechモードではUnicode絵文字も削除されるため、文字通りに読まれることはありません。

## インストールスクリプトが存在する理由

アップストリームのパッケージングメタデータがpipフレンドリーではなく、`dacvae`がPyPIにないため、直接`pip install git+https://github.com/Aratako/Irodori-TTS`を実行すると現在失敗します。インストールスクリプトはパッケージレイアウトにパッチを当て、ピン留めされたGitHubの依存関係をインストールします。

`Irodori-TTS`と`dacvae`はどちらもGitHubからインストールされます。サイレントなアップストリームの変更がインストールに影響を与えるのを防ぐため、スクリプトは両方を特定のコミットSHA（`install-irodori.ps1`の先頭で定義されています）にピン留めします。

## 環境変数

| 変数 | デフォルト値 | 目的 |
|---|---|---|
| `IRODORI_TTS_MODEL_ID` | `Aratako/Irodori-TTS-500M-v2` | HuggingFaceモデルリポジトリ |
| `TOMORI_TTS_HOST` | `127.0.0.1` | サーバーのバインドアドレス |
| `TOMORI_TTS_PORT` | `8013` | サーバーのポート |
| `IRODORI_MODEL_DEVICE` | `cuda` / `cpu` | 推論デバイス |
| `IRODORI_CODEC_DEVICE` | モデルデバイスと同じ | コーデックデバイス |
| `IRODORI_MODEL_PRECISION` | `bf16` (GPU) / `fp32` (CPU) | モデル精度 |
| `IRODORI_CODEC_PRECISION` | `fp32` | コーデック精度 |
| `TOMORI_TTS_MAX_TEXT_CHARS` | `1000` | リクエストごとのテキスト長の上限 |
