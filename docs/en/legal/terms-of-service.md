---
title: Terms of Service
description: The terms governing use of the official hosted TomoriBot instance.
aiGenerated: false
---

Last updated: 2026-09-12

By setting up or interacting with TomoriBot, you accept these Terms and Discord's Terms of Service and Community Guidelines. These Terms apply to the official hosted TomoriBot instance on Discord. If you run your own copy from TomoriBot's open-source repository, you are not bound by these Terms; your use is governed by the AGPLv3 license in `LICENSE` instead, and you alone control data handling in your self-hosted environment.

## 1) Definition of Terms
For clarity, these terms are used throughout this document:
- **Server**: A Discord guild/community where TomoriBot is set up
- **Memories**: Facts or information taught to TomoriBot via commands, or self-taught through the `remember_this_fact` function tool
- **Persona/Preset**: Configurable personality and behavioral profiles that change how TomoriBot responds
- **Provider**: Third-party AI or search services (e.g., Google, NovelAI, OpenRouter, Brave Search) that you configure TomoriBot to use
- **Hosted Instance**: The official TomoriBot service maintained as a public bot for Discord, as opposed to self-hosted copies
- **API Key**: Authentication credentials you provide to connect TomoriBot to your chosen Providers
- **Trigger**: An event that causes TomoriBot to generate a response in a Discord text channel using your configured provider, such as: mentioning the bot, replying to its messages, using slash commands that require AI/search processing, or sending messages in channels where auto-reply is enabled. Triggers consume API credits/tokens from your provider account.
- **Server Manager**: A member with permission to configure TomoriBot for a Server, such as the member who runs `/setup`

## 2) Scope of Service
- TomoriBot is an AI-powered chatbot that responds to Discord interactions using external Providers that you configure.
- We may change, suspend, or end features of TomoriBot at any time for maintenance, safety, or legal reasons.

## 3) Who Accepts What
- A Server Manager accepts these Terms for the Server when completing `/setup`, and confirms there that they have read the Privacy Policy and will make that information available to the Server's members.
- A Server Manager cannot accept these Terms on another member's behalf, and does not warrant any other member's age or conduct. Each member accepts these Terms for themselves by interacting with TomoriBot.
- Members can read the current documents at any time with `/legal terms-of-service` and `/legal privacy-policy`.
- Server Managers are responsible for telling their members that TomoriBot is installed and how it processes messages, and for using the available channel and role controls to limit where TomoriBot reads messages.

## 4) Your Responsibilities
- Do not use TomoriBot for unlawful, harmful, or platform-disallowed content, harassment, or unauthorized access attempts.
- You must meet the minimum age Discord requires in your country, which is at least 13, to use TomoriBot. By using the service, you represent that you meet this age requirement.
- You remain responsible for content you provide (messages, memories, persona data, uploads). Ensure you have rights to share it, and avoid sensitive data you do not want processed by your configured Providers.
- Respect rate limits and avoid spam or abuse that degrades the service.

## 5) Age-Restricted Content
- Features that produce adult content are off by default and must be deliberately enabled by a Server Manager.
- A Server Manager who enables them confirms that they are 18 or older and that the content will be confined to channels Discord marks as age-restricted, which are accessible only to adults.
- Content that is prohibited by Discord's Community Guidelines or by law remains prohibited regardless of any setting, channel marking, or age confirmation.
- We may disable these features for a Server, or remove access entirely, where they appear to be reaching minors or producing prohibited content.

## 6) Third-Party Providers and Models
- You may connect TomoriBot to external Providers (e.g., Anthropic, Google Gemini, OpenAI/OpenRouter, NovelAI, Brave Search). Their terms, privacy policies, safety filters, and billing apply to any content you send through them.
- Accepting these Terms covers TomoriBot only. It is not acceptance of any Provider's terms, and it does not relieve you of them. Review your chosen Provider's terms before configuring it with TomoriBot.
- TomoriBot is not affiliated with, endorsed by, or sponsored by Discord or any of these Providers. We are an independent service that integrates with their APIs.
- We cannot control the behavior, retention, or safety policies of those Providers.
- AI-generated content may be inaccurate, biased, or inappropriate despite safety filters. TomoriBot does not verify or endorse AI outputs.

## 7) API Keys and Billing
- If you supply API keys for AI/search providers, you authorize TomoriBot to store and use them to fulfill your requests. All provided keys are encrypted at rest.
- You must only provide API keys that you are legally authorized to use. This means keys obtained directly from the provider under your own account, or keys explicitly authorized for your use by the account holder. The following are strictly prohibited:
  - Stolen, leaked, or compromised API keys
  - Keys purchased from unauthorized third parties or black markets
  - Keys shared in violation of the provider's terms of service
- You assume all legal responsibility for the legitimacy of API keys you provide.
- We will only use your API keys to process your explicit interactions with TomoriBot. We do not pool API keys, use your keys to process other users' requests, or use them for testing, development, analytics, or any purpose other than fulfilling you and your server members' direct requests to TomoriBot.
- You are responsible for all provider-side costs and account usage caused by each TomoriBot Trigger associated with your API key. Monitor your API key dashboards for usage and billing. The `/tool estimate cost` command provides a rough estimate of per-trigger costs.
- We recommend using API keys with minimal required permissions, and provider-side rate limits and spending caps where available.

## 8) Data Handling
- Data collected, retention periods, and usage purposes are described in the [Privacy Policy](/legal/privacy-policy/).
- You can export or erase your data with the commands listed in that document. `/personal nuke` erases your personal data across every Server; `/nuke` erases a Server's data and is limited to Server Managers.
- Content owned by a Server, such as Server memories and uploaded documents, survives a personal erasure with your authorship removed. Ask a Server Manager to remove specific entries with `/memories`.
- Some operational records may persist for their stated retention period, or longer where required by law or for security.

## 9) Availability, Support, and Changes
- Service availability is not guaranteed. Outages, maintenance, or rate limits may interrupt responses.
- We may update these Terms at any time. Material changes will be announced with at least 30 days' notice through the support Discord or project repository, and will be reflected by updating the "Last updated" date. Continuing to use the bot after changes means you accept the revised Terms.

## 10) Termination
- We may suspend or remove access for violations of these Terms, legal requirements, or safety/security concerns.
- You may remove TomoriBot at any time. Consider running `/nuke` before removal, since a Server's data is otherwise kept so the configuration survives a re-invitation.

## 11) Disclaimers and Liability
- The service is provided "AS IS" and "AS AVAILABLE" without warranties of any kind. We disclaim implied warranties of merchantability, fitness for a particular purpose, non-infringement, and uninterrupted availability.
- We encrypt credentials at rest, use TLS with certificate verification for database connections, and restrict database access to the bot's runtime and operators with infrastructure access. No system is completely secure, and we cannot guarantee protection against all threats, breaches, or unauthorized access.
- To the maximum extent permitted by law, we are not liable for:
  - Indirect, incidental, consequential, or punitive damages
  - Actions of third-party providers or users
  - Unauthorized access to, theft of, corruption of, or loss of any data stored by TomoriBot (including API keys, memories, personas, and configurations)
  - Any damages except in cases of gross negligence or intentional misconduct on our part
- Our total liability is limited to the greater of (a) amounts you paid us for the service (typically $0 USD; voluntary donations are not payment for service) or (b) $10 USD in aggregate for all claims.
- By using the hosted TomoriBot service, you accept these risks. If you are uncomfortable with them, consider self-hosting TomoriBot from the open-source repository, where you maintain full control over data storage, encryption, and security practices.
- Nothing in these Terms limits rights that cannot be limited under the law that applies to you.

## 12) Reports and Contact
- For questions, abuse reports, security reports, or a report that TomoriBot holds data about someone below the applicable minimum age, email `bredrumb@gmail.com` or reach us in the [official TomoriBot support Discord server](https://discord.gg/bjCfHm9QsB).
- Please use email or a direct message rather than a public GitHub issue for anything involving personal data or a security vulnerability.
