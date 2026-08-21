export default {
  nuke: {
    description: `サーバーのすべてのデータを完全に消去します。実行後は再度 /setup の実行が必要です。`,
    confirmation_description: `このサーバーのデータを永久に削除することを確認してください。元に戻せません。`,
    confirmation_choice_yes: `はい、消去します`,
    confirmation_choice_no: `いいえ、キャンセル`,
    preserve_personas_description: `ペルソナとその属性・設定・記憶をそのまま残します（ペルソナツリーは削除しません）。`,
    cancelled_title: `消去をキャンセルしました`,
    cancelled_description: `データは変更されていません。サーバーデータはそのままです。`,
    success_full_title: `サーバーを消去しました`,
    success_full_description: `ペルソナを含むすべてのサーバーデータを消去しました。Discord側で削除したWebhook: **{webhooks_deleted}** 件（失敗: **{webhooks_failed}** 件）。\`/setup\` を実行して新しく始めてください。`,
    success_preserved_title: `サーバーを消去しました（ペルソナは保持）`,
    success_preserved_description: `サーバー設定、ホワイトリスト、クォータ、トリガー、連携を消去しました。ペルソナとその属性・記憶は保持されています。Discord側で削除したWebhook: **{webhooks_deleted}** 件（失敗: **{webhooks_failed}** 件）。\`/setup\` を実行してサーバーレベルの設定を再構成してください。`,
  },
};
