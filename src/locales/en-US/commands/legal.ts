export default {
  legal: {
    description: `View TomoriBot's terms of service, privacy policy, and license.`,
    // The two policy leaves register only on the hosted instance, so a self-hosted bot advertises
    // the license alone rather than a document set it does not expose.
    "license-only": {
      description: `View TomoriBot's open-source license.`,
    },
    "privacy-policy": {
      description: `View TomoriBot's Privacy Policy`,
      title: `Privacy Policy`,
      description_text: `View TomoriBot's Privacy Policy to understand how I handle your data. This applies to the official hosted instance. Self-hosted instances control their own data handling.`,
      link_title: `Full Privacy Policy`,
    },
    "terms-of-service": {
      description: `View TomoriBot's Terms of Service`,
      title: `Terms of Service`,
      description_text: `View TomoriBot's Terms of Service to understand the rules and guidelines for using the bot. This applies to the official hosted instance. Self-hosted instances are governed by the AGPLv3 license.`,
      link_title: `Full Terms of Service`,
    },
    license: {
      description: `View TomoriBot's open-source license`,
      title: `Open Source License`,
      description_text: `TomoriBot is open-source software licensed under the GNU Affero General Public License v3.0 (AGPLv3). This license allows you to use, modify, and distribute the code freely, with the requirement that any modifications to publicly hosted instances must also be open-sourced.`,
      link_title: `Full AGPLv3 License`,
    },
  },
};
