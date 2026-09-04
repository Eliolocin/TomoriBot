---
title: "WhisperXの文字起こし"
sidebar:
  order: 1
---

WhisperXは、初心者向けに推奨されるローカル文字起こしの方法です。

## セットアップ

TomoriBotのリポジトリのルート（TomoriBotをクローンしたフォルダー）から以下のコマンドを実行します。最初のコマンドでSTTサーバーのフォルダーに移動します。

### Windows PowerShell

```powershell
cd servers/stt
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python whisperx_server.py
```

### Linux/macOS Bash

```bash
cd servers/stt
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python whisperx_server.py
```

TomoriBotがWhisperXを使用している間は、そのターミナルを開いたままにしてください。デフォルトのエンドポイントURLは`http://127.0.0.1:8021`です。

## TomoriBotへの登録

`/providers`で **Add New Custom Endpoint** を選びます。

- API Compatibility: `openai-compatible-transcription`
- `endpoint_url`: `http://127.0.0.1:8021`

保存したエンドポイントを選択し、**Add or Edit a Model** で新しい文字起こしモデルに以下を設定します。

- `Transcription Model`: `large-v3`、または`WHISPERX_MODEL`に設定されている値
- `Transcription Language`: 任意の言語ヒント（例: `en`や`ja`）

登録すると、エンドポイントはすぐに有効になります。今後、エンドポイントを切り替える場合にのみ`/providers`を使用します。

## 文字起こしの使用

登録後、TomoriBotは音声添付ファイルをバックグラウンドで文字起こしし、チャットコンテキストにテキストを追加します。文字起こしをチャットに表示して投稿したい場合にのみ、`/config` > Behavior > Noticesを使用してください。
