---
title: "Docker Compose"
sidebar:
  order: 3
---

Docker Composeは、TomoriBot**と**PostgreSQLをコンテナとしてビルドおよび実行します。これは[セットアップウィザード](/ja/self-hosting/setup-wizard/)および[手動セットアップ](/ja/self-hosting/manual-setup/)と並ぶ3つ目のインストール方法です。ホストにBunやPostgreSQLをインストールするよりも、すべてをDockerで実行したい場合に選択してください。セットアップウィザードは使用し**ません**。データベース接続は自動的に設定されます。

:::caution[ホスト側のスクリプトには依然としてホストツールが必要です]
ボットとデータベースをDockerで実行しても、メンテナンススクリプトはコンテナ化されません。`bun run backup`、`bun run restore-backup`、`bun run update`、`bun run rotate-keys` などは、引き続きホストのBunとホストのPostgreSQLクライアントツールを通じて実行されます。Compose固有の手順については、[メンテナンスとバックアップ](/ja/self-hosting/maintenance/)を参照してください。
:::

## 1. 必要な `.env` の値

サンプルファイルから開始します。

```sh
cp .env.example .env
```

次に、最低限以下の値を設定します。

| 変数 | 値 |
|---|---|
| `DISCORD_TOKEN` | Discordボットのトークン（`GuildMembers`、`MessageContent`、および `GuildPresences` の特権インテントを有効にしてください）。 |
| `CRYPTO_SECRET` | 保存されたAPIキーを暗号化するために使用される32文字の暗号化キー。 |
| `POSTGRES_PASSWORD` | データベースのパスワード。他のすべての `POSTGRES_*` の値は自動設定されます。 |

セットアップウィザードとは異なり、Composeは `CRYPTO_SECRET` を自動生成しません。ご自身で（任意の32文字の文字列を）設定してください。オプションの調整値は `.env.optional.example` からコピーできます。

:::note[データベース接続は自動的に行われます]
ComposeのPostgreSQLサービスは、内部のDockerネットワーク上で開発モード（SSLなし）で実行され、バンドルされているイメージには既に `pgvector` と `pg_cron` が設定されています。そのため、ドキュメント/RAGメモリーとスケジュールされたクリーンアップはすぐに機能します。Compose用に `POSTGRES_HOST`、`POSTGRES_PORT`、`POSTGRES_USER`、または `POSTGRES_DB` を設定しないでください。これらは自動的に管理されます。
:::

## 2. ビルドと実行

```sh
docker compose build   # 初回、またはコード/依存関係の変更後
docker compose up      # ボットとデータベース
```

以降の起動では、コードや依存関係を変更していない限り、`docker compose up` だけで十分です。ボットがオンラインになったら、Discordで `/setup` を実行してAIプロバイダーのキーを追加します。Discord側の操作については[クイックスタート](/ja/introduction/quickstart/)を参照してください。

## 3. オプションのサイドカー（Composeプロファイル）

サイドカーはComposeプロファイルを介してオプトインされるため、必要なものだけを実行できます。

```sh
# SearXNG（プライベートWeb検索）+ Crawl4AI（ブラウザレンダリングによるフェッチ）
docker compose --profile searxng --profile fetch-crawl4ai up
```

各サイドカーの詳細については、[SearXNG](/ja/self-hosting/local-endpoints/setup-searxng/)、[Crawl4AI](/ja/self-hosting/local-endpoints/setup-crawl4ai/)、および[ローカルモニタリング](/ja/self-hosting/local-monitoring/)を参照してください。

## メンテナンス、更新とバックアップ

Composeデプロイメントでのバックアップ優先の更新手順には `bun run update --docker` を使用します。Composeデータベースのバックアップと復元（ホストスクリプトの実行を含む）については、[メンテナンスとバックアップ](/ja/self-hosting/maintenance/)ページで説明されています。新しいバージョンをプルする前に、まずは[安全な移行](/ja/self-hosting/safe-migration/)から始めてください。
