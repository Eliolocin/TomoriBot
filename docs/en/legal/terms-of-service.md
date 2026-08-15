---
title: Terms of Service
description: The terms governing use of the official hosted TomoriBot instance.
aiGenerated: false
---

Last updated: 2026-01-15

By setting up or interacting with TomoriBot, you accept these Terms and Discord's Terms of Service and Community Guidelines. These Terms apply to the official hosted TomoriBot instance on Discord. If you run your own copy from TomoriBot's open-source repository, you are not bound by these Terms; your use is governed by the AGPLv3 license in `LICENSE` instead, and you alone control data handling in your self-hosted environment. 

## 1) Definition of Terms
For clarity, these terms are used throughout this document:
- **Server**: A Discord guild/community where TomoriBot is set up
- **Memories**: Facts or information taught to TomoriBot via `/teach` commands, or self-taught through the `remember_this_fact` function tool
- **Persona/Preset**: Configurable personality and behavioral profiles that change how TomoriBot responds
- **Provider**: Third-party AI or search services (e.g., Google, NovelAI, OpenRouter, Brave Search) that you configure TomoriBot to use
- **Hosted Instance**: The official TomoriBot service maintained as a public bot for Discord, as opposed to self-hosted copies
- **API Key**: Authentication credentials you provide to connect TomoriBot to your chosen Providers
- **Trigger**: An event that causes TomoriBot to generate a response in a Discord text channel using your configured provider, such as: mentioning the bot, replying to its messages, using slash commands that require AI/search processing, or sending messages in channels where auto-reply is enabled. Triggers consume API credits/tokens from your provider account.

## 2) Scope of Service
- TomoriBot is an AI-powered chatbot that responds to Discord interactions using external Providers that you configure.
- We may change, suspend, or end features of TomoriBot at any time for maintenance, safety, or legal reasons.

## 3) Your Responsibilities
- Do not use TomoriBot for unlawful, harmful, or platform-disallowed content, harassment, or unauthorized access attempts.
- You must be at least 13 years old (or the minimum age required by Discord in your jurisdiction) to use TomoriBot. By using the service, you represent that you meet this age requirement.
- You remain responsible for content you or your server members provide (messages, memories, persona data, uploads). Ensure you have rights to share it and avoid sensitive data you do not want processed by your configured Providers.
- Respect rate limits and avoid spam or abuse that degrades the service.

## 4) Third-Party Providers & Models
- You may connect TomoriBot to external Providers (e.g., Anthropic, Google Gemini, OpenAI/OpenRouter, NovelAI, Brave Search). Their terms, privacy policies, safety filters, and billing apply to any content you send through them.
- TomoriBot is not affiliated with, endorsed by, or sponsored by Discord or any of these Providers. We are an independent service that integrates with their APIs.
- We cannot control the behavior, retention, or safety policies of those Providers. Review your chosen Provider's terms before configuring them with TomoriBot.
- AI-generated content may be inaccurate, biased, or inappropriate despite safety filters. TomoriBot does not verify or endorse AI outputs.

## 5) API Keys and Billing
- If you supply API keys for AI/search providers, you authorize TomoriBot to store and use them to fulfill your requests. All provided keys are encrypted at rest.
- You must only provide API keys that you are legally authorized to use. This means keys obtained directly from the provider under your own account, or keys explicitly authorized for your use by the account holder. The following are strictly prohibited:
  - Stolen, leaked, or compromised API keys
  - Keys purchased from unauthorized third parties or black markets
  - Keys shared in violation of the provider's terms of service
- You assume all legal responsibility for the legitimacy of API keys you provide.
- We will only use your API keys to process your explicit interactions with TomoriBot. We do not pool API keys, use your keys to process other users' requests, or use them for testing, development, analytics, or any purpose other than fulfilling you and your server members' direct requests to TomoriBot.
- You are responsible for all provider-side costs and account usage caused by each TomoriBot Trigger associated with your API key. Monitor your API key dashboards for usage and billing. The `/tool estimate cost` command provides a rough estimate of per-trigger costs.
- We recommend using API keys with minimal required permissions and considering using provider-specific rate limits and spending caps where available.

## 6) Data Handling
- Data collected and usage purposes are described in the Privacy Policy, which you also accept by setting up or interacting with TomoriBot.
- You can export or delete your data using in-bot commands where available; some records may persist where required by law or for security.

## 7) Availability, Support, and Changes
- Service availability is not guaranteed. Outages, maintenance, or rate limits may interrupt responses.
- We may update these Terms at any time. Material changes will be announced with at least 30 days' notice through the support Discord or project GitHub, and will be reflected by updating the "Last updated" date. Continuing to use the bot after changes means you accept the revised Terms.

## 8) Termination
- We may suspend or remove access for violations of these Terms, legal requirements, or safety/security concerns. You may remove TomoriBot at any time; consider using the `/data delete` command to remove stored data before removal.

## 9) Disclaimers and Liability
- The service is provided "AS IS" and "AS AVAILABLE" without warranties of any kind. We disclaim implied warranties of merchantability, fitness for a particular purpose, non-infringement, and uninterrupted availability.
- We implement industry-standard security practices including encryption at rest, SSL/TLS for database connections with certificate verification, and secure credential handling. However, we cannot guarantee absolute security against all potential threats, breaches, or unauthorized access.
- To the maximum extent permitted by law, we are not liable for:       
  - Indirect, incidental, consequential, or punitive damages
  - Actions of third-party providers or users
  - Unauthorized access to, theft of, corruption of, or loss of any data stored by TomoriBot (including API keys, memories, personas, and configurations)
  - Any damages except in cases of gross negligence or intentional misconduct on our part
  - Our total liability is limited to the greater of (a) amounts you paid us for the service (typically $0 USD; voluntary donations are not payment for service) or (b) $10 USD in aggregate for all claims.
  - By using the hosted TomoriBot service, you accept these risks. If you are uncomfortable with these risks, consider self-hosting TomoriBot from the open-source repository, where you maintain full control over data storage, encryption, and security practices.

## 10) Contact
- For hosted instance questions or concerns, reach out via the email `bredrumb@gmail.com`, the project GitHub issues, or the [official TomoriBot support Discord server](https://discord.gg/bjCfHm9QsB).
