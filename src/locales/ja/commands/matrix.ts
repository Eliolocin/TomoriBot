export default {
  matrix: {
    link: {
      description: `DiscordチャンネルをMatrixルームに双方向リレーでリンクします`,
      channel_description: `リンクするDiscordチャンネル`,
      room_description: `リンクするMatrixルームID（例：!abc:matrix.org）`,
      success_title: `Matrixルームをリンクしました`,
      success_description: `<#{channel_id}>が\`{room_id}\`とブリッジされました。TomoriのメッセージがMatrixルームに表示され、Matrixのメッセージもここに表示されます。

セットアップ手順、Matrix側で使えるコマンド、現在の制限一覧は {help_matrix} を確認してください。`,
      invalid_room_title: `無効なルームID`,
      invalid_room_description: `MatrixルームIDは\`!\`で始まり\`:\`を含む必要があります（例：\`!abc:matrix.org\`）。ルームIDを確認して再試行してください。`,
      join_failed_description: `<#{channel_id}>が\`{room_id}\`にリンクされましたが、Matrixルームに自動的に参加できませんでした。\`{bot_user_id}\`をルームに手動で招待し、必要なら {help_matrix} でセットアップ手順と制限一覧を確認してください。`,
      encrypted_room_title: `暗号化されたルームはリンクできません`,
      encrypted_room_description: `\`{room_id}\`はエンドツーエンド暗号化が有効です。Matrixの暗号化は一度設定すると無効にできないため、このルームはブリッジに使用できません。暗号化なしの新しいMatrixルームを作成し、代わりに\`{bot_user_id}\`を招待してください。`,
      matrix_not_configured_title: `Matrixブリッジ利用不可`,
      matrix_not_configured_description: `このBotインスタンスではMatrixブリッジが設定されていません。有効にするにはBot管理者にお問い合わせください。`,
    },
    unlink: {
      description: `DiscordチャンネルからMatrixブリッジリンクを削除します`,
      channel_description: `Matrixルームからリンクを解除するDiscordチャンネル`,
      success_title: `Matrixルームのリンクを解除しました`,
      success_description: `<#{channel_id}>はどのMatrixルームともブリッジされていません。`,
      not_linked_title: `リンクされていません`,
      not_linked_description: `<#{channel_id}>にはMatrixルームがリンクされていません。`,
    },
  },
};
