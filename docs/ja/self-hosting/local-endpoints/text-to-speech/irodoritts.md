---
title: "IrodoriTTS"
---

Irodori-TTS v4.1は、日本語向けの音声合成モデルです。1つのチェックポイントでボイスクローニングとキャプションベースのVoiceDesignに対応しています。TomoriBotでは`servers/tts/irodoritts/`のローカルFastAPIラッパーを介して実行します。

デフォルトモデルは`Aratako/Irodori-TTS-v4.1-Small`です。`IRODORI_TTS_MODEL_ID`を設定すると、`phasefield-audio/Irodori-TTS-v4.1-Anime`などの互換Hugging Faceチェックポイントも使用できます。

## セットアップ

現在のIrodoriは、依存関係とPyTorchバックエンドの管理に`uv`を使用します。先に`uv`をインストールし、TomoriBotリポジトリのルートからセットアップスクリプトを実行してください。

### Windows PowerShell（NVIDIA）

```powershell
.\servers\tts\irodoritts\install-irodori.ps1 cu128
.\servers\tts\irodoritts\.venv\Scripts\python.exe servers\tts\irodoritts\server.py
```

### Linux Bash（NVIDIA）

```bash
bash servers/tts/irodoritts/install-irodori.sh cu128
servers/tts/irodoritts/.venv/bin/python servers/tts/irodoritts/server.py
```

セットアップスクリプトは`servers/tts/irodoritts/.venv`を作成するため、インストール後も`bun run launch --irodoritts`をそのまま使用できます。

利用可能なバックエンド:

- `cu128` — Windows/LinuxのNVIDIA CUDA 12.8
- `cpu` — CPUのみ、またはmacOSのCPU/MPS
- `rocm` — Linux/WSLのAMD ROCm
- `xpu` — Windows/LinuxのIntel XPU

デフォルトのエンドポイントURLは`http://127.0.0.1:8013`です。

## 別のチェックポイントを使用する

デフォルトモデルは`Aratako/Irodori-TTS-v4.1-Small`です。環境変数を設定することで、互換性のあるHugging Faceリポジトリやコミュニティファインチューン（`phasefield-audio/Irodori-TTS-v4.1-Anime`など）、またはローカルのチェックポイントファイルを指定できます。

サイドカー起動時（Pythonによる直接起動、または`bun run launch --irodoritts`）、サーバーはリポジトリ直下の`.env`（または`servers/tts/irodoritts/.env`）を自動的に読み込み、起動時に使用中のモデルIDをログ出力します。

### `.env` を使用する場合（設定を保持）

TomoriBotのルートにある`.env`ファイルに追記します。

```env
IRODORI_TTS_MODEL_ID="phasefield-audio/Irodori-TTS-v4.1-Anime"
```

### セッションごとに環境変数を指定する場合

Windows PowerShellの場合:

```powershell
$env:IRODORI_TTS_MODEL_ID = "phasefield-audio/Irodori-TTS-v4.1-Anime"
.\servers\tts\irodoritts\.venv\Scripts\python.exe servers\tts\irodoritts\server.py
```

Linux Bashの場合:

```bash
IRODORI_TTS_MODEL_ID=phasefield-audio/Irodori-TTS-v4.1-Anime \
  servers/tts/irodoritts/.venv/bin/python servers/tts/irodoritts/server.py
```

### ローカルのチェックポイントファイルを使用する場合

チェックポイントファイル（`.pt`または`.safetensors`）をローカルにダウンロードしている場合は、`IRODORI_TTS_CHECKPOINT`にファイルパスを指定します。

```env
IRODORI_TTS_CHECKPOINT="/path/to/custom_checkpoint.pt"
```

現在のIrodoriは、チェックポイントとHugging Faceリポジトリ内のトークナイザー資産をまとめて取得します。モデル側が提供している場合は、`IRODORI_TTS_MODEL_ID`でHugging Faceのサブフォルダ版も指定できます。

## TomoriBotへの登録

`/providers`で **Add New Custom Endpoint** を選びます。

- API Compatibility: `tts-clone`
- `endpoint_url`: `http://127.0.0.1:8013`

保存したエンドポイントを選択し、モデルドロップダウンから音声モデルを追加します。v4.1では以下の設定を推奨します。

- `Voice Source Mode`: `Auto`
- `Script Markup Style`: `Emoji`

`Auto`では、同じIrodoriエンドポイントでTomoriBotの両方の音声モードを利用できます。エモーション表現も途切れません。

- Persona > Voiceで音声サンプルを割り当てたペルソナは、保存済みの参照音声を使ってボイスクローニングします。
- Persona > VoiceでVoiceDesignプロンプトを設定したペルソナは、保存済みの自然言語プロンプトをIrodoriのキャプション条件として使用します。

参照音声によるボイスクローニングだけを使いたい場合は、Voice Source Modeで従来どおり`Voice Clone`を選択しても構いません。

登録すると、エンドポイントはすぐに有効になります。今後、speechエンドポイントを切り替える場合にのみ`/providers`を使用します。

## ペルソナ音声のセットアップ

### ボイスクローニング

1. 背景音楽のない、1人の話者による10〜20秒のクリアな日本語の音声クリップを準備します。
2. `/config`を実行し、Models > TTS Parameters & Voicesでクリップをアップロードします。
3. `/config`を実行し、Persona > Voiceでペルソナと音声サンプルを選択します。

Irodori v4.1は旧v2より長い参照条件に対応していますが、単純な長さよりも音声の品質のほうが重要です。

### VoiceDesign

1. `/config`を実行し、Persona > Voiceを開きます。
2. ペルソナを選択します。
3. 希望する声質や話し方を自然言語で記述します。

TomoriBotはこのプロンプトを`instruct`として送信し、Irodoriラッパーがv4.1の`caption`条件に変換します。VoiceDesignでは参照音声は不要です。

TomoriBotはTTSへ送信する前にDiscordのカスタム絵文字構文を削除します。`script_markup: emoji`では、Unicode絵文字をIrodoriのテキスト条件用に保持します。

## Sway Samplingで高速化

デフォルトは高品質寄りの40ステップlinear samplingです。レイテンシを下げたい場合は、ステップ数を減らしたSway Samplingを試せます。

```powershell
$env:IRODORI_NUM_STEPS = "6"
$env:IRODORI_T_SCHEDULE_MODE = "sway"
$env:IRODORI_SWAY_COEFF = "-1.0"
```

品質と速度のトレードオフがあるため、常用する前に使用するチェックポイントと音声で確認してください。

## インストールスクリプトが簡単になった理由

以前のTomoriBotインストーラーはIrodoriの`pyproject.toml`にパッチを当て、`dacvae`を手動インストールし、古いv2時代のIrodoriコミットを固定していました。当時のパッケージ構成では必要な回避策でしたが、現在のIrodoriでは適切ではありません。

現在はサイドカー専用の`pyproject.toml`を用意し、アップストリームと同じ`uv`ベースのバックエンド構成を使います。再現可能なインストールのためIrodoriと`dacvae`の既知コミットは固定しますが、インストール時にアップストリームのソースコードを書き換えることはありません。

## 環境変数

| 変数 | デフォルト値 | 目的 |
|---|---|---|
| `IRODORI_TTS_MODEL_ID` | `Aratako/Irodori-TTS-v4.1-Small` | Hugging Faceモデル、または対応するrepo/subfolder指定 |
| `IRODORI_TTS_CHECKPOINT` | 未設定 | 任意のローカル`.pt` / `.safetensors`チェックポイント。設定時はHugging Faceモデルより優先 |
| `TOMORI_TTS_HOST` | `127.0.0.1` | サーバーのバインドアドレス |
| `TOMORI_TTS_PORT` | `8013` | サーバーポート |
| `IRODORI_MODEL_DEVICE` | `auto` | モデルデバイス（`auto`、`cuda`、`cpu`、`mps`、`xpu`） |
| `IRODORI_CODEC_DEVICE` | `auto` | コーデックデバイス |
| `IRODORI_MODEL_PRECISION` | CUDAでは`bf16`、それ以外は`fp32` | モデル精度 |
| `IRODORI_CODEC_PRECISION` | `fp32` | コーデック精度 |
| `IRODORI_COMPILE_MODEL` | `false` | Irodoriモデルで`torch.compile`を有効化 |
| `IRODORI_COMPILE_DYNAMIC` | `false` | コンパイル時にdynamic shapesを有効化 |
| `IRODORI_NUM_STEPS` | `40` | Euler samplingのステップ数 |
| `IRODORI_T_SCHEDULE_MODE` | `linear` | サンプリングスケジュール（`linear` / `sway`） |
| `IRODORI_SWAY_COEFF` | `-1.0` | `sway`使用時の係数 |
| `IRODORI_CFG_SCALE_TEXT` | `3.0` | テキスト条件のguidance scale |
| `IRODORI_CFG_SCALE_CAPTION` | `3.0` | Caption / VoiceDesign条件のguidance scale |
| `IRODORI_CFG_SCALE_SPEAKER` | `5.0` | 参照話者条件のguidance scale |
| `IRODORI_MAX_REF_SECONDS` | チェックポイント側のデフォルト | 参照音声長の任意上限 |
| `TOMORI_TTS_MAX_TEXT_CHARS` | `1000` | 1リクエストあたりのテキスト長上限 |
