---
title: "Matrixブリッジ"
sidebar:
  order: 1
---

TomoriBotは、**Matrixの部屋**とDiscordのチャンネルをブリッジできます。ユーザーがMatrixからチャットすると、メッセージがDiscordにWebhookメッセージとして中継され、トモリはMatrixの部屋に返信します。
このページはユーザー向けのブリッジ機能について説明しています。アプリサービス内部の仕組みについては、[Matrixブリッジのアーキテクチャ](/ja/architecture/integrations/matrix/bridge/)をご覧ください。

## セットアップ

1. 設定済みのMatrixのbotアカウントを、**暗号化されていない**Matrixの部屋に招待します。
2. その部屋の**Internal Room ID**をコピーします。
3. ブリッジしたいDiscordのチャンネルで`/server matrix link`を実行し、部屋のIDを貼り付けます。

botが招待を受け入れると、Matrixの部屋に短いリマインダーが投稿されます。リンクの完了は、引き続きDiscordから`/server matrix link`で行います。

### 部屋のIDを見つける

ほとんどのMatrixクライアントでは、**Room Settings → Advanced → Internal Room ID**にあります。`!abc:matrix.org`のような形式です。

## Matrixからの利用

- 部屋がリンクされたら、普通に話しかけてください。MatrixのメッセージはDiscordチャンネルに中継されます。
- トモリはMatrixの部屋に返信します。
- Matrixのテキストコマンドは`/kill`と`/refresh`のみ使用可能です。

## 現在の制限事項

- Matrixからスラッシュコマンドは使用できません（`/kill`と`/refresh`を除く）。
- DMやDMベースのクールダウンのリマインダーはサポートされていません。
- トモリはMatrixのプロフィール画像を見ることができません。
- メッセージをピン留めすることはできません。
- カスタム絵文字やMarkdownは確実にレンダリングされません。埋め込みはプレーンテキストとして中継されます。
- Matrixユーザーの個人のメモリーは、属性付きのサーバーメモリーにフォールバックされます。

## 注意事項

- botが自動的に参加しない場合は、手動でMatrixのbotアカウントを招待し、再度`/server matrix link`を実行してください。
- **Matrixの暗号化は後から無効にできません**。暗号化された部屋は、新しく暗号化されていない部屋に置き換える必要があります。
- 上記に記載されていない制限事項がある場合は、動作するはずだと想定し、サポートサーバー（`/support discord`）でバグを報告してください。

Discord内で同じガイドを見るには、`/help`の **連携** から **Matrix** を開いてください。
