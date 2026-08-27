---
title: "Threat Models"
---

> Evidence paths under `terraform/` and `deploy/` cited below live on the `release` branch and are
> absent from `main`. Read one with `git show release:terraform/aws/ecs-health-check.tf`.

## TL;DR

- **API keys are encrypted** in the database with `pgcrypto`. A full DB dump is useless without the `CRYPTO_SECRET`. If the host or secret is compromised, rotate all provider keys immediately.
- **SQL injection is defended** by Bun SQL template literals. This only holds as long as developers keep using them, so please never concatenate raw values into queries.
- **Discord roles are the trust boundary.** `ManageGuild` = admin power. A misconfigured Discord role is a real privilege escalation.
- **LLM output is untrusted.** Prompt injection through memories, documents, web pages, or MCP tool descriptions is a real attack surface, use `/tool prompt snapshot` to check source of malicious prompts.
- **MCP servers run with host-level trust.** A malicious local MCP server owns the machine. Only run MCP servers you trust, under least-privilege OS accounts.
- **BYO endpoints can see your data.** Custom text, image, TTS, and STT endpoints receive the full request payload. This is inherent, endpoint operators own that risk.
- **SSRF is mitigated** by `fetchUserRemoteUrl()` and `safeDownload()`. New code touching user-supplied URLs must use these helpers as skipping them is a SSRF hole.
- **Set quotas, enable BYOK mode, and disable feature flags** (image gen, video gen, cross-channel messaging, manage-message, prompt snapshot) unless you actually need them to prevent users from abusing your key's rate limits.

---

This document outlines the threat model for TomoriBot using the STRIDE framework and groups risks by attack vector.

Related reference:
- `docs/en/architecture/subsystems/security.md`
- `docs/en/architecture/pipelines/tool-loop/` (tool-loop pipeline reference)
- `docs/en/architecture/integrations/matrix/bridge.md`
- `docs/en/architecture/integrations/voice/README.md`

---

## 1. Database, Secrets, and Tenant Isolation

TomoriBot stores server configuration, personas, memories, API credentials, managed webhook tokens, Matrix links, custom endpoints, quota state, reminders, and caches in PostgreSQL.

| Threat (STRIDE) | Scenario | Risk | Current Mitigation | Implementation Area | Residual Risk / Assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tampering / Elevation of Privilege** | SQL injection through Discord messages, slash command options, persona text, imported presets, memories, or endpoint settings. | Critical | Bun SQL tagged template literals for values. Dynamic update field names are constrained by schema-derived allowlists. | `src/utils/db/client.ts`, `src/utils/db/sqlSecurity.ts`, `src/utils/db/repositories/*`, `src/utils/db/repository*Sql.ts` | Developers must keep using parameterized SQL and the field-validation helpers for dynamic column names. |
| **Information Disclosure** | Cross-server or cross-user leakage from a missing `server_id`, `user_id`, `persona_id`, persona lineage, or Discord channel filter. | High | Application-layer tenant scoping is embedded in DB helpers and command handlers. Personal/server memory paths are separate, and many export/delete operations are scope-specific. | `src/utils/db/*`, `src/commands/memory/*`, `src/commands/personal/*`, `src/commands/server/*` | There is no database row-level security policy; correctness depends on query scoping and review. |
| **Information Disclosure** | API keys or webhook tokens leak from the database. | High | Provider keys, optional keys, key-rotation rows, and managed Discord webhook tokens are encrypted with PostgreSQL `pgcrypto` and key versions. | `src/utils/security/crypto.ts`, `src/utils/security/keyManager.ts`, `src/utils/db/managedWebhookDb.ts`, `src/db/schema.sql` | A DB dump plus the active encryption secret can decrypt stored secrets. Rotate credentials after suspected host or secret compromise. |
| **Repudiation / Tampering** | A user claims they did not create, edit, or delete memory/configuration. | Medium | Slash commands are Discord-authenticated, and logging includes command/user/server metadata in many paths. | `src/commands/*`, `src/utils/misc/logger.ts` | Logging is operational, not a tamper-proof audit log. |
| **Denial of Service** | Large memory imports, document memories, vector operations, or message history imports consume DB/CPU. | Medium | Memory/document limits, quotas, cooldowns, and size checks are applied before writes in most user-facing paths. | `src/utils/db/memoryLimits.ts`, `src/utils/security/rateLimiter.ts`, `src/utils/db/cooldownManager.ts` | Expensive queries remain possible if future features bypass shared limit helpers. |
| **Tampering / Stale State** | Caches continue serving old permissions, config, memories, webhooks, or Matrix links after a write. | Medium | Cache invalidation is implemented near successful write paths for key state. | `src/utils/cache/*`, `src/utils/bridges/matrix/*` | New DB writes must invalidate matching caches only after successful writes. |

---

## 2. Discord Commands, Permissions, and Webhooks

Discord is both the identity provider and the primary execution surface.

| Threat (STRIDE) | Scenario | Risk | Current Mitigation | Implementation Area | Residual Risk / Assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Elevation of Privilege** | A normal user invokes server-management commands to change provider keys, personas, Matrix links, quotas, whitelist/blacklist settings, memory imports, or prompt configuration. | High | Command loader applies `ManageGuild` to server/config categories, and sensitive commands also check `interaction.memberPermissions`. | `src/utils/discord/commandLoader.ts`, `src/commands/server/*`, `src/commands/config/*`, `src/commands/persona/*` | Discord permissions are the trust boundary. Misconfigured server roles can grant real admin power. |
| **Spoofing** | A foreign webhook or bot message is treated as TomoriBot/persona output, poisoning reply attribution or causing response loops. | High | Triggers ignore standard bot messages. Foreign bot messages are loaded into context as normal users. Webhook attribution relies on display names, meaning a foreign webhook sharing a persona name is treated as persona output in history. | `src/utils/chat/admission.ts`, `src/utils/chat/contextPipeline.ts`, `src/utils/chat/replyDecision.ts` | Unauthorized webhooks can inject persona history due to display-name matching. Admins must restrict webhook creation. |
| **Information Disclosure / Spoofing** | Managed Discord webhook token theft lets an attacker post as a persona. | High | Managed webhook tokens are encrypted at rest and tied to a channel/guild. The bot reuses or creates managed webhooks instead of asking users to provide tokens. | `src/utils/discord/webhookManager.ts`, `src/utils/db/managedWebhookDb.ts` | If the decrypted token leaks from host memory/logs, Discord treats it as bearer auth for that webhook until rotated/deleted. |
| **Tampering** | LLM-driven `manage_message` pins, edits, or deletes messages unexpectedly. | Medium | Runtime checks limit edit/delete to direct bot messages or managed persona webhook messages. Pin requires bot `ManageMessages`. Message refs are opaque `ref_N` handles in prompt context. | `src/tools/functionCalls/manageMessageTool.ts`, `src/utils/text/messageIdMap.ts` | The tool executes with bot permissions, not the human user's Discord permissions. Server admins should keep the feature flag disabled where not wanted. |
| **Tampering** | LLM-driven `create_thread` creates unwanted channels of conversation. | Medium | Runtime requires `thread_creation_enabled`, bot `CreatePublicThreads` and `SendMessagesInThreads`, and target-channel visibility for the invoking member. Target resolution fails closed on ambiguous names and does not create threads inside threads. | `src/tools/functionCalls/createThreadTool.ts`, `src/utils/discord/targetResolver.ts` | The thread is created with bot permissions. Server admins should disable the feature flag where thread creation should stay manual. |
| **Information Disclosure** | `cross_channel_message` peeks into a channel and leaks recent messages back to another channel. | High | Runtime requires bot `ViewChannel`, requires the invoking guild member to have `ViewChannel` on the target, and dispatch requires bot `SendMessages` or `SendMessagesInThreads`. The server cross-channel blocklist blocks configured channels and forum/media parents. | `src/tools/functionCalls/crossChannelMessageTool.ts`, `src/commands/server/crosschannel-blocklist.ts` | The bot can still expose messages from channels visible to the invoker and bot. Admins should block sensitive channels where cross-channel tool use is unwanted. |
| **Information Disclosure** | Hidden tool notices or fallback details leak private-channel activity into a public thought-log channel. | Medium | Hidden notices are suppressed for private channels and DMs instead of rerouted. | `src/utils/discord/toolProgressNotice.ts` | Thought-log channels should still be treated as sensitive operational logs. |
| **Denial of Service** | Users spam interactions, message triggers, edits, webhooks, or Discord API calls to hit rate limits. | Medium | Discord.js handles 429s; TomoriBot uses message/command cooldowns, stream locks, queues, quotas, and emergency memory-pressure cooldowns. | `src/utils/db/messageCooldown.ts`, `src/utils/db/cooldownManager.ts`, `src/utils/security/rateLimiter.ts`, `src/events/rateLimit/rateLimitLogger.ts` | ManageGuild users are exempt from some cooldowns by design. A compromised admin account can still cause spend and rate-limit pressure. |

---

## 3. LLM, Prompt, Persona, and Tool Execution

LLM output is untrusted. The model can be manipulated by users, memories, documents, web pages, tool results, MCP descriptions, and persona prompts.

| Threat (STRIDE) | Scenario | Risk | Current Mitigation | Implementation Area | Residual Risk / Assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tampering** | Prompt injection or jailbreak causes persona drift, unsafe instructions, or attempts to reveal system/developer prompt content. | Medium | Context assembly separates structured system/persona/tool/history blocks, and built-in behavior is enforced in TypeScript where possible. | `src/utils/text/contextBuilder.ts`, `src/events/messageCreate/tomoriChat.ts` | Perfect prompt-injection defense is impossible. Treat all generated text and tool calls as hostile until checked by execution code. |
| **Information Disclosure** | `/tool prompt snapshot` exposes assembled prompt, memories, messages, media references, or system instructions. | High | Command has its own gate: `ManageGuild` bypasses, otherwise `prompt_snapshot_enabled` must allow non-admin access. | `src/commands/tool/prompt/snapshot.ts` | Enabling prompt snapshots for non-admins intentionally expands disclosure. |
| **Tampering / Information Disclosure** | RAG, server memories, personal memories, imported memories, documents, or SillyTavern presets poison future context or leak sensitive content to later generations. | High | Memory scopes are separated, personal privacy levels can block personal memory use, server/user limits exist, and management/export/remove commands are scoped. | `src/utils/db/memoryLimits.ts`, `src/commands/memory/*`, `src/commands/personal/privacy.ts`, `src/utils/text/contextBuilder.ts` | Server-wide memory is inherently shared. Moderators must remove poisoned or sensitive server memory. |
| **Elevation of Privilege** | User prompt causes an unauthorized tool call. | High | Built-in tool availability is filtered before advertisement. Individual tools also perform concrete runtime checks for high-impact operations such as memory, quotas, message management, image/video generation, and cross-channel access. | `src/tools/toolRegistry.ts`, `src/tools/functionCalls/*` | There is not one universal execution-layer RBAC gate for every feature flag; tools must enforce their own critical checks. New tools must fail closed in `execute()`. |
| **Information Disclosure** | Opaque Discord snowflakes, raw message IDs, or media IDs appear in prompt context and are reused incorrectly. | Medium | Recent-message targets are exposed as opaque `media_N` / `ref_N` handles and resolved back before execution. | `src/utils/text/messageIdMap.ts`, `src/tools/toolRegistry.ts` | Some legacy raw IDs are still accepted at execution time for compatibility. |
| **Denial of Service / Cost Exhaustion** | Long prompts, recursive requests, tool loops, video/image generation, or repeated retries consume tokens and provider credits. | High | Message fetch limits, media windows, token/context trimming, stream flood guards, cooldowns, and text/image/video quotas. | `src/utils/security/rateLimiter.ts`, `src/utils/quota/*`, `src/events/messageCreate/tomoriChat.ts`, `src/utils/discord/streamOrchestrator.ts` | Admins must configure quotas and feature flags for their risk tolerance. |

---

## 4. MCP and Web/Search Tools

TomoriBot supports bundled MCP servers, a REST-backed Brave engine (consumed internally by the unified `web_search` tool's dispatcher), bundled URL fetching consumed internally by the unified `fetch_url` dispatcher, optional self-hosted SearXNG and Crawl4AI sidecars, and guild-registered remote MCP servers.

| Threat (STRIDE) | Scenario | Risk | Current Mitigation | Implementation Area | Residual Risk / Assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Elevation of Privilege** | A local MCP server runs malicious code on the host. | Critical | Local MCP servers are operator-controlled deployment components. TomoriBot does not sandbox the MCP process itself. | `src/utils/mcp/mcpManager.ts`, `src/tools/mcpServers/*` | Operators must only run trusted local MCP servers under least-privilege OS/container accounts. |
| **Information Disclosure** | Remote guild MCP URL points at localhost, RFC1918, link-local, metadata IPs, or other internal services. | High | Remote URL validation blocks private/reserved/loopback addresses in production, requires HTTPS in production, allows localhost HTTP only for development, and validates before each HTTP transport request. | `src/utils/security/remoteUrlSecurity.ts`, `src/utils/security/userRemoteFetch.ts`, `src/utils/mcp/guildMcpManager.ts` | Bun's undici DNS interceptor support is best effort; validation still runs, but DNS pinning can fall back when unavailable. |
| **Tampering** | MCP tool descriptions, names, schemas, or results contain prompt injection. | High | Tool names that collide with built-in or global MCP names are skipped. Tool results are returned through the tool pipeline rather than granted direct DB/filesystem access. | `src/tools/toolRegistry.ts`, `src/utils/mcp/guildMcpManager.ts`, `src/utils/mcp/mcpExecutor.ts` | Admin-registered MCP tools are trusted. A malicious MCP can still manipulate model behavior through text output. |
| **Elevation of Privilege** | Dangerous MCP tool such as shell execution or broad file access is registered and the LLM calls it. | Critical | TomoriBot only passes arguments to registered MCP tools; it does not provide host filesystem or shell access by itself. | `src/utils/mcp/*` | Security depends on MCP server design and admin trust. Do not expose dangerous MCP tools to guilds. |
| **Information Disclosure / SSRF** | Web fetch/search tools retrieve attacker-controlled pages, huge responses, internal URLs, or pages containing data-exfiltration prompts. | Medium / High | Fetch size checks, max content truncation, progress notices, feature flags, production private-target blocking before `fetch_url` dispatch (enforced when `RUN_ENV=production` unless `FETCH_URL_ALLOW_PRIVATE_NETWORK=true`; auto-relaxed outside production), and SSRF-protected remote fetch paths for guild MCP HTTP transports. | `src/tools/fetchUrl/*`, `src/utils/mcp/mcpExecutor.ts`, `src/tools/restAPIs/brave/*` | Search/fetch output is untrusted prompt content. Built-in Brave result image fetches and third-party search APIs should be treated as external content. |
| **Elevation of Privilege / Information Disclosure** | A compromised SearXNG sidecar image makes outbound calls under the task's network/IAM identity or attempts to read other co-located container state. | High | Sidecar receives only `SEARXNG_SECRET` from Secrets Manager — never the combined `tomoribot/production` secret. The retained legacy GCP Terraform disables the sidecar by default. Image is intended to be pinned by sha256 digest when enabled (see `servers/searxng/README.md` upgrade procedure). | `terraform/aws/ecs-health-check.tf`, `terraform/gcp/cloud-run.tf`, `servers/searxng/README.md` | Defaults in `docker-compose.yaml` and the optional sidecar image variable use `searxng/searxng:latest`. Production deployments that enable SearXNG must override with a pinned digest before merge, otherwise an upstream image rotation can auto-deploy on the next task restart. |
| **Information Disclosure / Open Proxy Abuse** | The SearXNG sidecar is exposed beyond the private container network (e.g. added to Cloud Run public ingress or a public ALB), turning it into an open metasearch proxy. | High | `servers/searxng/limiter.toml` disables bot detection on the assumption that only TomoriBot on the private network talks to the sidecar. Deployment configs bind SearXNG to loopback (`http://localhost:8080/`) inside the task / pod and never publish port 8080. | `servers/searxng/limiter.toml`, `docker-compose.yaml`, `terraform/aws/ecs-health-check.tf`, `terraform/gcp/cloud-run.tf` | If operators expose port 8080 publicly, anonymous internet traffic can use the instance to scrape Google/Bing/Brave on the operator's behalf. Never add SearXNG to public ingress. Never expose `SEARXNG_BASE_URL` as a per-guild slash-command setting — that would make it a user-controlled URL and require `fetchUserRemoteUrl()`. |
| **Information Disclosure / SSRF / Open Proxy Abuse** | A user URL or redirect targets loopback, a private network, link-local services, or cloud metadata. | High | The default `safe_http` engine validates and DNS-pins each redirect hop, caps redirects and response bytes, and in production blocks internal targets unless `FETCH_URL_ALLOW_PRIVATE_NETWORK=true` (the guard auto-relaxes outside production, `RUN_ENV` != `production`). Cloud instance-metadata / link-local addresses (`169.254.0.0/16` incl. `169.254.169.254`, IPv6 link-local, AWS IPv6 IMDS) are blocked by an always-on denylist (`src/utils/security/cloudMetadata.ts`) that neither the dev auto-relax nor the opt-in can bypass, in both the pre-dispatch gate (`urlSafety.ts`) and the connection/redirect gate (`remoteUrlSecurity.ts`). Custom-provider and remote-MCP HTTP calls use the same guarded fetcher. Crawl4AI is only admitted where private-network fetching is permitted because its browser follows redirects outside the bot process; the pre-dispatch metadata denylist is its sole in-bot SSRF check. | `src/utils/security/userRemoteFetch.ts`, `src/tools/fetchUrl/*`, `src/utils/security/remoteUrlSecurity.ts` | Browser-rendered fetch output remains untrusted prompt content. Do not enable private-network fetching in production, and keep sidecar ports unpublished. |

---

## 5. Custom Provider, Endpoint, Speech, and Transcription Surfaces

Custom endpoints include text, embedding, image, video, speech/TTS, and transcription/STT capabilities. Server-scoped endpoints are admin configured. Personal endpoints are user scoped and use stricter URL policy.

| Threat (STRIDE) | Scenario | Risk | Current Mitigation | Implementation Area | Residual Risk / Assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Information Disclosure / SSRF** | Custom endpoint URL targets internal infrastructure or changes DNS after validation. | High | Registration uses `validateRemoteUrl()`. Runtime custom endpoint calls use `fetchUserRemoteUrl()`, which revalidates redirects and resolves target hosts before sending. Personal endpoints pass `strict: true`. | `src/commands/config/custom-endpoint/*`, `src/commands/personal/custom-endpoint/*`, `src/providers/custom/*`, `src/utils/security/userRemoteFetch.ts` | Server endpoints can use localhost in non-production for local development. Production must keep `RUN_ENV=production`. |
| **Information Disclosure** | Provider request sends chat history, images, audio, voice samples, or memories to an attacker-controlled custom endpoint. | High | Endpoint registration is explicit and admin/user scoped. Credentials are attached only for that configured endpoint/provider. | `src/utils/provider/credentialResolver.ts`, `src/utils/provider/customEndpointService.ts`, `src/providers/custom/*` | This is inherent BYO endpoint behavior. Endpoint owners can see request payloads sent to them. |
| **Information Disclosure** | Speech/TTS clone endpoint receives a stored voice sample and generated script. | High | Speech endpoints are server-scoped admin configuration. Voice sample storage is explicit, and TTS requires an assigned persona voice. | `src/providers/custom/styles/ttsCloningAdapter.ts`, `src/utils/storage/voiceSampleStorage.ts`, `src/tools/functionCalls/generateVoiceMessageTool.ts` | Voice samples are biometric-like data. Treat speech endpoints and storage buckets as sensitive. |
| **Information Disclosure** | Transcription endpoint receives user-uploaded audio from Discord messages. | High | STT only runs when a transcription endpoint is configured. Audio download uses size and timeout checks. | `src/utils/audio/audioAttachmentTranscription.ts`, `src/providers/custom/styles/transcriptionOpenAIAdapter.ts` | Users in enabled servers should expect audio attachments may be transcribed and sent to the configured STT endpoint. |
| **Information Disclosure / SSRF** | Runtime speech/transcription adapters use a stored endpoint URL that has changed DNS since registration. | High | Runtime TTS and STT calls use `fetchUserRemoteUrl()` for the configured endpoint URL, so DNS validation and redirect handling are repeated before sending audio or voice-sample payloads. | `src/providers/custom/styles/ttsCloningAdapter.ts`, `src/providers/custom/styles/transcriptionOpenAIAdapter.ts`, `src/utils/security/userRemoteFetch.ts` | Server endpoints remain admin-controlled and can intentionally send audio to the configured service. Production must keep `RUN_ENV=production` for strict server-endpoint SSRF policy. |
| **Tampering / DoS** | ComfyUI or custom image/video workflow JSON is malicious, huge, or unexpectedly expensive. | Medium | Workflow JSON is provided during endpoint setup and stored in endpoint config. Generation is gated by image/video feature flags and quotas. | `src/commands/config/custom-endpoint/add.ts`, `src/providers/custom/customEndpointDispatcher.ts`, `src/utils/quota/*` | The remote workflow runtime is outside TomoriBot's sandbox. Endpoint operators own that risk. |

---

## 6. File, Attachment, Media, and Asset Processing

TomoriBot processes Discord attachments, images, videos, GIFs, PDFs/text files, audio, avatars, character references, and Matrix media.

| Threat (STRIDE) | Scenario | Risk | Current Mitigation | Implementation Area | Residual Risk / Assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Denial of Service** | Oversized or slow Discord attachment downloads exhaust memory or worker time. | High | `safeDownload()` pre-checks known size, validates the target URL through `fetchUserRemoteUrl()`, enforces content-length and final size checks, and uses timeouts. User-uploaded workflow/config imports, media-context images, GIFs, avatars, character references, and provider-returned media downloads use the shared wrapper. | `src/utils/security/safeDownload.ts`, `src/utils/documents/textExtractor.ts`, `src/utils/audio/audioAttachmentTranscription.ts`, `src/utils/teach/batchUploadUtils.ts`, `src/utils/image/*` | Fixed first-party provider API calls still use direct `fetch()`. |
| **Denial of Service** | Malicious PDF or text file stalls `pdf-parse`, string normalization, or the single-threaded runtime. | High | File size limit, known-binary extension/MIME blocklist, memory-pressure guard, text length truncation. | `src/tools/functionCalls/readFileTool.ts`, `src/utils/documents/textExtractor.ts`, `src/utils/security/rateLimiter.ts` | A crafted file under the size cap can still stress parsers. Process supervision remains important. |
| **Information Disclosure** | `read_file`, image analysis, or GIF processing exposes attachments from recent messages. | Medium | Tools use recent-message windows and opaque `media_N` handles. | `src/tools/functionCalls/readFileTool.ts`, `src/tools/functionCalls/analyzeImageTool.ts`, `src/tools/functionCalls/processGifTool.ts` | These tools operate with bot channel visibility. Sensitive attachments in channels visible to the bot may be sent to the configured model/provider. |
| **Information Disclosure / SSRF** | Avatar or character-reference storage loads arbitrary remote URLs. | Medium | User upload paths go through safe download; local stored paths are constrained under `data/avatars`, `data/charreferences`, and `data/voice-samples`; remote character references are reloaded with `safeDownload()`/`fetchUserRemoteUrl()` URL validation. | `src/utils/storage/avatarStorage.ts`, `src/utils/storage/charrefStorage.ts`, `src/utils/storage/voiceSampleStorage.ts` | Stored remote assets should still be limited to Tomori-controlled S3/CloudFront or Discord CDN where possible. |
| **Tampering / Information Disclosure** | Image/video generation or analysis sends user images, avatars, stickers, emoji, or embeds to model providers. | Medium / High | Feature flags, provider capability checks, quota checks, and prompt-visible progress notices. | `src/tools/functionCalls/generateImageTool.ts`, `src/tools/functionCalls/generateImageNaiTool.ts`, `src/tools/functionCalls/generateVideoTool.ts`, `src/utils/image/*` | Provider privacy guarantees are outside TomoriBot. Users should not upload sensitive media into model-enabled channels. |

---

## 7. Matrix Bridge

The Matrix bridge is optional and runs as a Matrix appservice. It relays Matrix messages into Discord through webhooks and relays TomoriBot responses back to Matrix through virtual persona users.

| Threat (STRIDE) | Scenario | Risk | Current Mitigation | Implementation Area | Residual Risk / Assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Spoofing / Elevation of Privilege** | Unauthorized callers post Matrix appservice transactions to TomoriBot. | Critical | `matrix-appservice-bridge` registration uses `MATRIX_HS_TOKEN` for homeserver-to-appservice authentication. Public callback URL must be HTTPS unless localhost. | `src/utils/bridges/matrix/events.ts` | Deployment must not expose the appservice listener without the homeserver auth path. Keep `MATRIX_HS_TOKEN` secret. |
| **Information Disclosure** | A Matrix room is linked to a sensitive Discord channel by mistake. | High | `/server matrix link` requires `ManageGuild`, checks room encryption state, and stores explicit room-channel links. | `src/commands/server/matrix/link.ts`, `src/utils/bridges/matrix/rooms.ts` | Once linked, Matrix room members can interact with the Discord channel through the bridge. Room membership is controlled on the Matrix side. |
| **Information Disclosure** | E2EE Matrix rooms are linked, causing unreadable or misleading bridge behavior. | Medium | Link command checks for `m.room.encryption` and blocks encrypted rooms. | `src/utils/bridges/matrix/rooms.ts`, `src/commands/server/matrix/link.ts` | If the encryption check fails, code proceeds optimistically per comments; operators should keep linked rooms unencrypted. |
| **Spoofing** | Remote Matrix users choose names resembling personas or Discord users. | Medium | Discord webhook username includes `[Matrix|@user:server] localpart`; bridge user IDs are tracked in context. Virtual persona loop prevention checks the configured homeserver suffix. | `src/utils/bridges/*`, `src/utils/bridges/matrix/*`, `src/events/messageCreate/tomoriChat.ts` | Human readers can still be fooled by display names. Treat Matrix identity as Matrix ID plus homeserver, not localpart alone. |
| **Denial of Service** | Matrix media events relay large files into Discord or exhaust memory. | Medium | Media relay enforces `MATRIX_MAX_ATTACHMENT_MB`, timeout, content-length, and final buffer size checks. | `src/utils/bridges/matrix/media.ts`, `src/events/messageCreate/matrixRelay.ts` | Files are proxied through the configured homeserver using appservice auth. A hostile homeserver can still pressure the bridge within configured limits. |
| **Tampering / DoS** | Any Matrix user in a linked room issues `/kill` or `/refresh`. | Medium | Commands are limited to linked Matrix rooms and affect only the linked Discord channel. | `src/utils/bridges/matrix/events.ts` | These Matrix text commands are not Discord-permission-gated. Matrix room moderation is the control. |

---

## 8. Supply Chain, Build, and Deployment

| Threat (STRIDE) | Scenario | Risk | Current Mitigation | Implementation Area | Residual Risk / Assumption |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tampering / Elevation of Privilege** | Malicious dependency update runs code during install/build/runtime. | High | `bun.lock`, dependency pinning/overrides, patches, CI audit, and container scanning guidance. | `package.json`, `bun.lock`, `patches/`, `.github/workflows/*`, `Dockerfile` | Upstream registry or maintainer compromise remains possible. Review lockfile diffs carefully. |
| **Information Disclosure** | CI/CD secrets leak through logs or compromised actions. | High | Production deployment uses OIDC where documented and avoids long-lived static AWS credentials where possible. | `.github/workflows/*`, `docs/en/architecture/subsystems/security.md` | GitHub Actions and cloud IAM configuration remain part of the trust boundary. |
| **Information Disclosure / Tampering** | Production secrets are loaded from the wrong source or missing key versions break decryption. | High | Production uses AWS Secrets Manager; startup validates required secrets and initializes key manager after loading. Versioned encryption keys support rotation. | `src/utils/security/secretsManager.ts`, `src/index.ts`, `src/utils/security/keyManager.ts` | `RUN_ENV` must be set correctly. Removing old key versions before rotation completes can make rows undecryptable. |
| **Denial of Service** | Runtime memory leak, parser crash, provider hang, or unhandled promise crashes the process. | Medium | Memory monitor/guardrails, provider timeouts in several adapters, stream error handling, and operational process restart expectations. | `src/timers/memoryMonitor.ts`, `src/utils/security/rateLimiter.ts`, provider adapters | External process supervision is still required for production reliability. |

---

## Security Follow-Ups

These are actionable hardening items from the residual-risk column. Keep this section focused on concrete work, not general advice.

### Should Fix

| Area | Issue | Suggested Action |
| :--- | :--- | :--- |
| Tool execution | Critical runtime checks are implemented by individual tools rather than a single universal final gate. | Standardize fail-closed checks for feature flags, quota source, Discord permissions, target ownership, and target visibility in shared helpers, then audit every built-in tool against them. |

### Operational Hardening

| Area | Action |
| :--- | :--- |
| MCP | Document that shell, file, database, or broad-network MCP servers are equivalent to granting host or internal-network access. |
| Matrix | Document production appservice exposure requirements, token rotation expectations, and room moderation requirements for `/kill` and `/refresh`. |
| Secrets | Document the rotation procedure after provider key, webhook token, Matrix token, or host compromise. |
| Discord permissions | Recommend least-privilege bot channel access and call out that several tools operate with bot visibility. |
| Quotas and feature flags | Recommend conservative defaults for image, video, cross-channel, web fetch, prompt snapshot, and manage-message features. |

---

## Contributor Checklist

1. Enforce security in TypeScript, not only in prompts.
2. Use `fetchUserRemoteUrl()` for user-supplied or admin-configured remote endpoints unless the URL is a fixed first-party provider URL.
3. Use `safeDownload()` or equivalent size/timeout/final-size checks for user-controlled media.
4. Use Bun SQL template literals for values and `sqlSecurity.ts` helpers for dynamic columns.
5. Scope all DB reads/writes by server/user/persona/channel as appropriate.
6. Invalidate caches after successful writes, in the same code path.
7. New tools must perform critical feature-flag, permission, quota, and target-ownership checks inside `execute()`, even if they are filtered before advertisement.
8. Treat MCP definitions, MCP results, web pages, documents, memories, imports, and custom endpoint responses as untrusted prompt content.
