---
title: "SillyTavernサポート"
# Keyword-rich <title> targeting "SillyTavern character cards in Discord"
# queries; replaces Starlight's default for this page only. H1 and sidebar
# keep the plain title.
head:
  - tag: title
    content: "TomoriBot | DiscordでSillyTavernのカードを使用"
# Hand-written search snippet; overrides the auto-derived description from
# routeData.ts middleware.
description: "TomoriBotを使用して、SillyTavernのキャラクターカードとプリセットをDiscordにインポートします。"
sidebar:
  order: 2
---

TomoriBotは、[SillyTavern](https://github.com/SillyTavern/SillyTavern)から、おそらくすでにお持ちの2つの要素をインポートできます。**プロンプトマネージャーのプリセット**（プロンプトの構成）と、**キャラクターカード**（キャラクター自体）です。これはSTユーザー向けのニッチな機能です。SillyTavernを使用したことがない場合は、このページをスキップして構いません。

## キャラクターカードのインポート

`/persona import`を使用して、既存のSillyTavernのキャラクターをDiscordに直接持ち込むことができます。以下の形式に対応しています。

- `chara`または`char`のメタデータが埋め込まれた**PNGカード**
- **v2スタイルのJSON**カード（ルートレベルの`name`、`description`、`first_mes`など）
- **v3 JSON**カード（`spec: "chara_card_v3"`とネストされた`data`オブジェクト）
- **`.charx`アーカイブ**（Character Card V3。カード配布サイトが標準で配布する形式です）

`.charx`ファイルは、`card.json`にキャラクターを格納したzipです。TomoriBotはそのカードのみを読み取り、アーカイブ内のそれ以外は無視します。同梱のアイコン、感情スプライト、音声、動画はインポートされず、その旨はインポート結果に表示されます。アバターは`/server avatar`で設定し、スプライトは`/config` > Persona > Spritesで追加してください。

ファイルにTomoriBotのメタデータがない場合でも、有効なSTのv2/v3カードであれば、インポート時に自動的にSillyTavernの変換処理が実行されます。また、カードを`/persona generate`に渡して、新しいペルソナに変換することもできます。

インポートされるデータは、保存される前に検証スキーマを通過します（デフォルトの上限：1文字列あたり5,000文字、属性200個、片側のサンプル会話100個、トリガーワード100個。セルフホスト環境では`PRESET_MAX_*`の環境変数で調整可能です）。アーカイブの読み取りは`MAX_CHARX_*`の環境変数で別途制限されます。アーカイブの圧縮サイズは展開後のサイズを示さないためです。正確な変換とフィールドのマッピングについては、[カードサポートのアーキテクチャ](/ja/architecture/integrations/sillytavern/card-support/)をご覧ください。

## プロンプトのプリセット

SillyTavernのプロンプトマネージャーのプリセットは、プロンプトの**レイアウト**を制御します。`/config`でインポートし、`/config`で有効なノードを確認し、`/config`で通常のレイアウトに戻します。

### プリセットが制御するもの

- プロンプトの順序とマーカーの配置
- カスタムプロンプトのノード
- 履歴の後（post-history）や深さ指定の挿入（depth-injection）ノード
- インポートされたノードの初期の有効・無効状態

### プリセットが置き換えないもの

プリセットは*レイアウト*を管理するものであり、すべてのテキストソースを管理するわけではありません。以下はプリセットと並行して存在します。

- ユーザーのシステムやペルソナのブロック：`/config` > Engine > General、`/config` > Persona > Advanced、`/config` > Persona > Identity & Personality。
- ライブチャットの履歴と検索されたドキュメントのコンテキスト。
- TomoriBotの自動コンテキスト：サーバーメモリー、絵文字・スタンプのコンテキスト、会話中のユーザー、短期メモリー、条件付け、および同様のブロック。

### ネイティブのブロックのマッピング

- `main` → 現在のシステムプロンプト（`/config` > Engine > Generalで設定されたもの、または組み込みのフォールバック）
- `charDescription` → `/config` > Persona > Advanced
- `charPersonality` → `/config` > Persona > Identity & Personality
- `dialogueExamples` → `/config` > Persona > Identity & Personality
- `chatHistory` → ライブチャンネルの履歴
- `worldInfoBefore` / `worldInfoAfter` → 検索されたドキュメントのコンテキスト（STのlorebookではありません）

### システムプロンプトのルール

プリセットがアクティブな間は、組み込みのフォールバックのシステムプロンプトは削除されます。ただし、`/config` > Engine > Generalで独自のプロンプトを設定している場合は、引き続き送信されます。

### 互換性に関する注意事項

プリセットが無視されているように見える場合のよくある原因は以下の通りです。

- インポート済 ≠ 送信：`prompt_order`で無効になっているノードは、`/config`で有効にするまでオフのままです。コメントのみや空のノードは送信されず、不明なマーカーはスキップされます。
- 順序は文字通り適用されます。`chatHistory`を`dialogueExamples`の前に配置すると、ライブチャットが先に送信されます。
- 履歴の後（post-history）や深さ指定の挿入（depth-injection）は、独立したメッセージになるのではなく、既存のチャット履歴のエントリーに統合されます。同じ深さの複数のノードはバッチ処理されます。
- 正規表現による後処理、プリセット側のtemperature、top-p、モデルのオーバーライド、および階層化されたプリセットはサポートされていません。古いテキスト補完のプリセットは、ST専用のブロック（scenario、anchors、stop stringsなど）を破棄するベストエフォートなパスでインポートされます。

Discord内のリファレンスについては、`/help`の **連携** から **SillyTavernプリセット** を開いてください。インポートエンジンの内部については、[プリセットシステムのアーキテクチャ](/ja/architecture/integrations/sillytavern/preset-system/)をご覧ください。
