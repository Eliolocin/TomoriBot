---
title: "プロンプトの中身"
sidebar:
  order: 2
---

TomoriBotをトリガーするたびに、以下の内容が組み立てられ、設定されているテキストモデルへメインのプロンプト（コンテキスト）として、この順序で送信されます：

| ブロック | 任意？ | コマンド | 内容 |
|---|---|---|---|
| [**システムプロンプト**](/ja/features/chatting-personality/behavior-tweaking/#system-prompt) | | `/config system-prompt set`（`preset`、`remove` も） | コンテキストの最上部にある基本的な指示。 |

> **デフォルトのシステムプロンプト**（サーバーのシステムプロンプトが未設定のときのみ使用されます）：
>
> *"You are {bot}. {bot} makes sure to respond short and concisely by default. {bot} only makes lengthy responses if the situation warrants it.
>
> {{if tool:create_long_term_memory}}{bot} proactively uses the available {memory_tool} whenever someone shares a detail or {bot} notices one in the conversation that is actually worth remembering, such as a preference, an interest, or an important fact, preferring to remember things even if it is minor as long as it's not a duplicate of what {bot} already knows. {{/if}}{{if tool:update_long_term_memory}}{bot} uses {memory_update_tool} instead when new information changes or adds onto something {bot} already remembers, rather than saving a duplicate.{{/if}}
>
> {{if tool:review_capabilities}}When someone asks what {bot} can do or why something is unavailable, {bot} checks {capabilities_tool} before answering. {{/if}}{{if tool_family:url_fetch}}When more detail is needed, {bot} uses {url_fetch_tool} on `https://docs.tomoribot.app/llms.txt` for information.{{/if}}"*

| ブロック | 任意？ | コマンド | 内容 |
|---|---|---|---|
| **チャンネルプロンプト（追加）** | *（任意）* | `/server channel-prompt` | チャンネルごとに異なり、システムプロンプトの直後に重ねられます。同じコマンドの*replace*モードは、新しいブロックを追加するのではなく、上記のシステムプロンプトの枠を丸ごと置き換えます。 |
| **ペルソナプロンプト** | *（任意）* | `/persona prompt set`（`remove` も） | システムプロンプトとは別に、アクティブなペルソナ専用に書かれたプロンプト。 |
| [**ペルソナ属性**](/ja/features/chatting-personality/multiple-personas/#attributes) | | `/persona attribute add`（`edit`、`remove` も） | アクティブなペルソナの性格特性と話し方のパターン。 |
| **サーバー情報** | | *（Discordから、コマンドなし）* | サーバー名、説明、彼女がいるチャンネル。Discord自体から取得されます。 |
| [**ペルソナ・ユーザーブロック**](/ja/features/capabilities/tools-and-extensions/#built-in-tools) | *（任意）* | 確認・解除は `/moderation`。`/capabilities manage userblocking` でゲート | このペルソナが特定のユーザーに対して保持している、有効なミュート/ブロック制限。 |
| [**サーバーの記憶**](/ja/features/knowledge/memory/#personal-vs-server-memories) | | `/memories`（`edit`、`remove` も） | このサーバー用に保存された長期的な事実。 |
| [**サーバーの絵文字**](/ja/features/chatting-personality/behavior-tweaking/#capabilities-what-shes-allowed-to-do) | *（任意）* | `/capabilities manage emojiusage`（切り替えのみ）、初期化は `/expressions initialize` | サーバーに存在するカスタム絵文字。 |
| [**サーバーのスタンプ**](/ja/features/chatting-personality/behavior-tweaking/#capabilities-what-shes-allowed-to-do) | *（任意）* | `/capabilities manage stickerusage`（切り替えのみ）、初期化は `/expressions initialize` | サーバーに存在するカスタムスタンプ。 |
| [**ペルソナスプライト**](/ja/features/chatting-personality/multiple-personas/#sprites-emotion-avatars) | *（任意）* | `/persona sprites add`（`edit`、`remove` も） | ペルソナに設定された、名前付きの表情スプライト（もしあれば）。 |
| [**会話の参加者**](/ja/features/knowledge/memory/#personal-vs-server-memories) | *（任意）* | `/personal memories`。`/capabilities manage personalization` でゲート | 会話にいる人、そのニックネームとメンションハンドル、各人について保存された個人の記憶。コンテキスト内でメッセージを発言している人、または名前・エイリアスが言及された人がいる場合に読み込まれます。フッターとして、現在のチャンネルと `/server timezone` によるローカル時刻も含みます。 |
| [**短期記憶**](/ja/features/knowledge/memory/#short-term-memory-stm) | | `/persona stm edit`（`view` も）。エントリーの削除は `/memories`。`/capabilities manage shorttermmemory` でゲート | 異なるチャンネルの要約と直近のメッセージを含みます |
| [**ドキュメント**](/ja/features/knowledge/memory/#document-knowledge-base-rag) | *（任意）* | `/memories`（`remove`、`view` も） | RAGを使ってナレッジベースから取り出された関連チャンク。 |
| [**条件付け**](/ja/features/knowledge/memory/#conditioning) | *（任意）* | `/reward <feed\|headpat\|hug\|kiss\|tickle>`、`/punish <bite\|bonk\|pinch\|spank\|squeeze>`、管理は `/conditioning manage` | このサーバーにおけるこのペルソナへの蓄積された行動の後押し。 |
| [**サンプル対話**](/ja/features/chatting-personality/multiple-personas/#sample-dialogues) | *（任意）* | `/persona sample-dialogue add`（`edit`、`remove` も） | このペルソナの話し方の例（設定されていれば）。 |
| [**直近のメッセージ**](/ja/features/chatting-personality/behavior-tweaking/#generation-tuning) | | `/config message-fetch-limit` | 実際の会話。この件数まで（デフォルト80件）。`/config context-note set` で設定した内容や再会ノートは、独立したブロックとしてではなく、設定可能な深さでこのブロックの中にインラインで挿入されます。 |

*（任意）* マークの行は、絵文字がなかったりドキュメントが一致しなかったりして何も言うことがない場合、何も追加せず（トークンも消費せず）にスキップされます。

直近のメッセージは最も大きく、最も脆い部分で、会話が進むにつれて前へずれていく窓です。それより上にあるものはすべて、保存された設定から再構築される安定した部分です。

`/tool prompt snapshot` は、あるペルソナ向けの束をそのままファイルに出力します。どの記憶が現在有効か、ドキュメントが一致したか、会話がどれだけ収まったかを判断するための、根拠となる情報です。

`/tool estimate cost` は同じ束をサイズ別に分解します。上限を引き上げる前に、何がコンテキストを消費しているかを把握するのに役立ちます。

### ツールはどこで定義される？

TomoriBotがネイティブに対応しているすべてのプロバイダーについて、ツールのスキーマはプロバイダー自身の `tools` フィールドを通じて送信されるため、扱いは使用しているプロバイダー・推論エンジンによって変わります。

### なぜTomoriBotは忘れるのか？

この順序が、「なぜ覚えていないの？」という疑問のほとんどを説明します：

| 起きたこと | 理由 |
|---|---|
| 今日の少し前のことを忘れた | メッセージ上限を超えてスクロールしました。それは**直近のメッセージ**にしか存在しておらず、Tomoriが長期記憶として保存しない限り、メッセージウィンドウの外に出た時点で忘れられます。 |
| 別のチャンネルでは知らない | **直近のメッセージ**はチャンネルごとです。チャンネルをまたぐのは**サーバーの記憶**、**会話の参加者**、**短期記憶**だけです。短期記憶は他のチャンネルの直近のメッセージを読み込むことである程度これを補いますが、すべてを持ち込むわけではありません。 |
| `/refresh` で忘れた | リフレッシュは**直近のメッセージ**を打ち切り、このチャンネルの**短期記憶**を消去しますが、長期記憶は削除されないはずです。打ち切り自体を取り消すには、リフレッシュの埋め込みメッセージを削除してください。 |
| 再起動後に忘れた | **直近のメッセージ**は再起動を一切乗り越えません |

上記すべてを乗り越えて残したいものは、**長期記憶**にする必要があります。[メモリー](/ja/features/knowledge/memory/#long-term-memory)を参照してください。

## ヒントとコツ

- `/config message-fetch-limit` は会話の窓を広げます（20〜100件）。コンテキストが増えるぶん、返信ごとのトークンも増えます。
- `/config context-note set` は短いリマインダーを指定した深さに挿入します。束の下の方、直近のメッセージの近くに配置されるため、システムプロンプト内のものより実行されやすくなります。記憶の保存頻度を上げるよう促すには、ここが最適な場所です。
- `/personal memories` と `/memories` は**サーバーの記憶**と**会話の参加者**に直接書き込みます。これはTomoriBotのコンテキストに知識を永続化させる、確実な方法の一つです。
