export default {
  "st-preset": {
    description: `SillyTavernプリセットを管理。詳しくは /help の連携からSillyTavernプリセットを開いてください。`,
    import: {
      description: `SillyTavernプリセットJSONをインポート。詳しくは /help の連携からSillyTavernプリセットを開いてください。`,
      file_description: `インポートするSillyTavernプリセットの.jsonファイル`,
      invalid_file_title: `無効なファイル`,
      file_too_large_title: `ファイルが大きすぎます`,
      file_too_large_description: `プリセットファイルは{max_size} MB以下にしてください。`,
      download_failed: `添付ファイルのダウンロードに失敗しました。もう一度お試しください。`,
      invalid_json: `ファイルを有効なJSONとして解析できませんでした。`,
      not_a_preset_title: `未対応のプリセット形式`,
      not_a_preset_description: `これは対応しているSillyTavernプリセットではないようです。対応しているのは **Chat Completions** プリセットのみです：Prompt Manager の \`prompts\` 配列、または \`context.story_string\` + \`sysprompt.content\` を使った旧形式のみです。\n\n**Text-completions プリセット**（\`instruct\` ブロックを使用するもの）は対応していません。`,
      no_nodes: `このプリセットに使用可能なプロンプトノードが見つかりませんでした。`,
      success_title: `プリセットをインポートしました`,
      success_description: `**{name}**をインポートしました。

• **{total}** 合計ノード
• **{markers}** 構造マーカー
• **{toggleable}** 切り替え可能ノード（**{enabled}** 有効）
{notes}
{stPresetToggle}でアクティブなノードを調整できます。
{helpStPreset}で、この環境でのプリセットの挙動を確認できます。
{stPresetRemove}でデフォルトの動作に戻せます。`,
      note_comment_only: `> **{count}** 個のコメントのみのノードが\`/config\`で表示されますが、プロンプトには挿入されません。`,
      note_disabled_by_preset: `> **{count}** 個のノードがこのプリセットでデフォルトで無効になっています。\`/config\`で有効にできます。`,
      note_unsupported_macros: `> 有効なノードに未対応のプリセットマクロが残っています: {macros}。その部分はそのまま送信されたり、この環境ではSTどおりに動かない場合があります。`,
      note_legacy_text_completion: `> この古い text-completions プリセットは、legacy の\`story_string\`からベストエフォートで変換されました。\`persona\`、\`scenario\`、アンカー、stop strings、古いバックエンド設定などの ST 専用要素は引き続き無視されます。`,
    },
    remove: {
      description: `インポートしたSillyTavernプリセットを削除`,
      no_preset_title: `プリセットが見つかりません`,
      no_preset_description: `このサーバーにインポートされたSillyTavernプリセットがありません。削除するものがありません。`,
      modal_title: `プリセットを削除`,
      checkbox_label: `プリセット（チェックを外すと削除）`,
      checkbox_label_continued: `プリセット（続き）`,
      checkbox_description: `削除したいプリセットのチェックを外してください。チェックされたプリセットは保持されます。`,
      no_removals_title: `プリセットは削除されませんでした`,
      no_removals_description: `すべてのプリセットが保持されました。削除するには少なくとも1つのチェックを外してください。`,
      failed_title: `削除に失敗しました`,
      failed_description: `1つ以上のプリセットの削除に失敗しました。もう一度お試しください。`,
      success_title: `プリセットを削除しました`,
      success_description: `**{count}**件のプリセットを削除しました: {names}{promoted_note}`,
      auto_promoted_note: `

**{name}**が新しいアクティブプリセットに設定されました。`,
    },
    switch: {
      description: `アクティブなSillyTavernプリセットを切り替え`,
      modal_title: `アクティブプリセットの切り替え`,
      select_label: `有効にするプリセットを選択`,
      select_placeholder: `プリセットを選択...`,
      no_presets_title: `プリセットが見つかりません`,
      no_presets_description: `SillyTavernプリセットがインポートされていません。\`/config\`で追加してください。`,
      single_preset_title: `プリセットが1件のみ`,
      single_preset_description: `インポートされたプリセットが1件のみです。切り替えるには\`/config\`でさらに追加してください。`,
      success_title: `プリセットを切り替えました`,
      success_description: `**{name}**がアクティブなSillyTavernプリセットになりました。`,
    },
    node: {
      description: `プリセットのプロンプトノードを管理`,
      toggle: {
        description: `プリセットのプロンプトノードのオン・オフを切り替え`,
        no_preset_title: `プリセットが見つかりません`,
        no_preset_description: `このサーバーにアクティブなSillyTavernプリセットがありません。まず\`/config\`でインポートしてください。`,
        no_nodes_title: `切り替え可能なノードがありません`,
        no_nodes_description: `このプリセットには切り替え可能なプロンプトノードがありません。`,
        select_page_title: `ページを選択`,
        select_page_description: `**{preset_name}**には**{total_nodes}**個の切り替え可能なノードが**{total_pages}**ページにわたってあります。
ページを選択してノードを表示・切り替え:`,
        group_description: `チェックで有効、チェック解除で無効`,
        done_button: `完了`,
        no_changes: `変更なし`,
        result_title: `ノード切り替え結果`,
        result_description: `**{enabled}** / **{total}** ノードが有効。

{changes}`,
      },
    },
  },
};
