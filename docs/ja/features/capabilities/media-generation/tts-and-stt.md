---
title: "音声: TTS & STT"
sidebar:
  order: 3
---

TomoriBotは、**話す**（テキスト読み上げ、TTS）ことと、**聞く**（音声認識、STT）ことができます：

- **TTS**を使用すると、ネイティブのDiscord音声メッセージで返信できます。
- **STT**を使用すると、ユーザーからの音声の添付ファイルを、会話のコンテキストとして使用できるテキストに変換できます。

どちらも同じエンドポイントシステムを通じて機能します。最も簡単な方法は**ElevenLabs**（クラウド版。詳細は下記）を使用することです。自身のハードウェアで音声を処理したい場合は、ローカルエンジンを使用し、セルフホストのガイドに従ってください。

## テキスト読み上げ（TTS）

### ElevenLabs（クラウド、最も簡単）

1. [ElevenLabs](https://elevenlabs.io/app/settings/api-keys)からAPIキーを取得します。
2. `/speech elevenlabs`を実行し、キーを貼り付けます。この1つのコマンドで以下のことが行われます：
   - ElevenLabsの**音声**エンドポイント（および**文字起こし**エンドポイント）を登録します。
   - それらをアクティブとして選択します。
   - その場で1つのペルソナに音声を割り当てることができます。
3. `/speech voice-assign`を使用して、追加のペルソナに音声を割り当てます。音声の閲覧は[ElevenLabs Voice Library](https://elevenlabs.io/app/voice-library)で行えます。ここから自身の音声をクローンすることもできます。

保存されたキーを更新するには、いつでも再度`/speech elevenlabs`を実行してください。

注意事項：

- **無料プランでは、用意された音声（premade voices）のみ機能します**。[用意された音声のリスト](https://elevenlabs-sdk.mintlify.app/voices/premade-voices)を参照してください。
- 音声メッセージの生成や読み上げ時には文字数がカウントされます。無料プランには月ごとの制限がありますので、ElevenLabsのダッシュボードを確認してください。
- 音声での返信は`voice_message_enabled`によって制限されており、アクティブなペルソナに音声が割り当てられている必要があります。

Discord上で同じ手順を確認するには、`/help`の **プロバイダー** から **音声生成** を開いてください。

### ローカルの音声クローンエンジン（セルフホスト）

セルフホストのインスタンスでは、代わりにローカルの音声クローンサーバーを実行できます。一般的なフローは以下の通りです：
ラッパーサーバーを起動し、`/provider custom-endpoint add`で登録し、`/model speech`で選択し、`/speech voice-add`でサンプルをアップロードし、最後に`/speech voice-assign`で割り当てます。どのような音声形式でも受け入れられます（モノラルのWAVに自動変換されます）。BGMのない10〜20秒のクリップが最適です。

各エンジンにはそれぞれセットアップガイドがあります：

- [Chatterbox-Turbo](/ja/self-hosting/local-endpoints/text-to-speech/chatterbox/)：高速、英語のみ対応。`[excited]`のような括弧付きの表現タグをサポートします。
- [Qwen3-TTS](/ja/self-hosting/local-endpoints/text-to-speech/qwen3tts/)：多言語対応（10言語）。自然言語によるVoiceDesignモードを備えています。
- [IrodoriTTS](/ja/self-hosting/local-endpoints/text-to-speech/irodoritts/)：日本語特化。絵文字を感情の合図として読み取ります。

一覧については、[テキスト読み上げ（TTS）](/ja/self-hosting/local-endpoints/text-to-speech/)ハブをご覧ください。

## 音声認識（STT）

文字起こしのエンドポイントは、ユーザーの音声添付ファイルをテキストに変換し、バックグラウンドでの会話のコンテキストとして機能させます。文字起こしがチャットに**表示して投稿される**かどうかは、`/speech transcripts`で個別に制御されます。

### ElevenLabs（クラウド）

上記ですでに説明した通り、`/speech elevenlabs`は音声とともに文字起こしのエンドポイントも登録します。文字起こしのエンドポイントを切り替えるには、`/model transcription`を使用します。

### ローカルエンジン（セルフホスト）

- [WhisperX](/ja/self-hosting/local-endpoints/speech-to-text/whisperx/)：ローカルでの推奨。約100言語対応、GPUアクセラレーション、複数のモデルサイズ。
- [KoboldCPP](/ja/self-hosting/local-endpoints/speech-to-text/koboldcpp/)：ご使用のビルドがOpenAI互換の文字起こしエンドポイントを公開している場合に機能します。
- [whisper.cpp](/ja/self-hosting/local-endpoints/speech-to-text/whispercpp/)。

一覧については、[音声認識（STT）](/ja/self-hosting/local-endpoints/speech-to-text/)ハブをご覧ください。Discordでの概要を確認するには、`/help`の **プロバイダー** から **文字起こし** を開いてください。
