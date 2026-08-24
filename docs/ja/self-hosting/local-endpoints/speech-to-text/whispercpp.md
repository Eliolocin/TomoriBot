---
title: "whisper.cppの文字起こし"
sidebar:
  order: 2
---

HTTPサーバーがOpenAI互換の`POST /v1/audio/transcriptions`エンドポイントを公開している場合、whisper.cppを使用できます。

## セットアップ

whisper.cppのHTTPサーバーを起動し、OpenAI互換の文字起こしエンドポイントを公開していることを確認します。

- `POST /v1/audio/transcriptions`
- `GET /v1/models` または `GET /models`

TomoriBotが使用している間は、サーバーを実行したままにしてください。エンドポイントURLはサーバーのルート（例: `http://127.0.0.1:8022`）です。

whisper.cppのビルドが異なるエンドポイント形式を公開している場合は、リクエストをTomoriBotが想定するOpenAI互換の形式にマッピングする薄いラッパーをその前に配置してください。

## TomoriBotへの登録

`/providers`で **Add New Custom Endpoint** を選びます。

- API Compatibility: `openai-compatible-transcription`
- `endpoint_url`: whisper.cppサーバーのルートURL

保存したエンドポイントを選択し、**Add or Edit a Model** で新しい文字起こしモデルに以下を設定します。

- `Transcription Model`: サーバーが報告するモデル名
- `Transcription Language`: 任意の言語ヒント（例: `en`や`ja`）

登録すると、エンドポイントはすぐに有効になります。今後、エンドポイントを切り替える場合にのみ`/model transcription`を使用します。

## 文字起こしの使用

登録後、TomoriBotは音声添付ファイルをバックグラウンドで文字起こしし、チャットコンテキストにテキストを追加します。文字起こしをチャットに表示して投稿したい場合にのみ、`/speech transcripts`を使用してください。
