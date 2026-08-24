---
title: "KoboldCPPの文字起こし"
sidebar:
  order: 3
---

KoboldCPPにはWhisperベースのSTTサポートがありますが、エンドポイントの形式はビルドによって異なる場合があります。TomoriBotのPhase 4アダプターは、OpenAI互換の`POST /v1/audio/transcriptions`を想定しています。

## セットアップ

Whisper/STTを有効にしてKoboldCPPを起動し、ビルドが以下を公開していることを確認します。

- `POST /v1/audio/transcriptions`
- `GET /v1/models` または `GET /models`

TomoriBotが使用している間は、KoboldCPPを実行したままにしてください。ビルドが`/api/extra/transcribe`または別のカスタム形式のみを公開している場合は、TomoriBotに専用のアダプターが搭載されるまでラッパーを使用してください。

## TomoriBotへの登録

`/providers`で **Add New Custom Endpoint** を選びます。

- API Compatibility: `openai-compatible-transcription`
- `endpoint_url`: KoboldCPPサーバーのルートURL

保存したエンドポイントを選択し、**Add or Edit a Model** で新しい文字起こしモデルに以下を設定します。

- `Transcription Model`: サーバーが報告するモデル名
- `Transcription Language`: 任意の言語ヒント（例: `en`や`ja`）

登録すると、エンドポイントはすぐに有効になります。今後、エンドポイントを切り替える場合にのみ`/model transcription`を使用します。

## 文字起こしの使用

登録後、TomoriBotは音声添付ファイルをバックグラウンドで文字起こしし、チャットコンテキストにテキストを追加します。文字起こしをチャットに表示して投稿したい場合にのみ、`/speech transcripts`を使用してください。
