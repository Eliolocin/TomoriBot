export default {
  legal: {
    // The two policy leaves register only on the hosted instance, so a self-hosted bot advertises
    // the license alone rather than a document set it does not expose.
    "license-only": {
      description: `TomoriBotのオープンソースライセンスを表示します。`,
    },
    "privacy-policy": {
      description: `TomoriBotのプライバシーポリシーを表示`,
      title: `プライバシーポリシー`,
      description_text: `TomoriBotのプライバシーポリシーを表示して、データの取り扱いについて理解してください。これは公式ホスト版インスタンスに適用されます。セルフホスト版インスタンスは独自のデータ処理を制御します。`,
      link_title: `完全なプライバシーポリシー`,
    },
    "terms-of-service": {
      description: `TomoriBotの利用規約を表示`,
      title: `利用規約`,
      description_text: `TomoriBotの利用規約を表示して、ボットの使用に関するルールとガイドラインを理解してください。これは公式ホスト版インスタンスに適用されます。セルフホスト版インスタンスはAGPLv3ライセンスに準拠します。`,
      link_title: `完全な利用規約`,
    },
    license: {
      description: `TomoriBotのオープンソースライセンスを表示`,
      title: `オープンソースライセンス`,
      description_text: `TomoriBotはGNU Affero General Public License v3.0（AGPLv3）の下でライセンスされたオープンソースソフトウェアです。このライセンスにより、コードを自由に使用、変更、配布できますが、公開ホストされたインスタンスへの変更もオープンソース化する必要があります。`,
      link_title: `完全なAGPLv3ライセンス`,
    },
  },
};
