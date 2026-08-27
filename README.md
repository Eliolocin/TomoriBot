## English | [日本語](.github/README_ja.md)

> [!NOTE]
> This README is a quick overview. For the full, up-to-date documentation (setup guides, feature walkthroughs, provider info, and more) visit **[docs.tomoribot.app](https://docs.tomoribot.app/)**.

<br />
<div align="center">

  <a href="https://github.com/Bredrumb/TomoriBot">
    <img src="assets/img/icons/tomoricon.svg" alt="Logo" width="80" height="80">
  </a>

<h3 align="center">TomoriBot</h3>

A self-hosted and customizable personal AI assistant/role-playing system for Discord with memory, multiple personas, tool calling, multimodality, and API/local model support.

<p align="center">
  <strong><a href="https://docs.tomoribot.app/">Official Website</a></strong>
  &middot;
  <strong><a href="https://discord.com/oauth2/authorize?client_id=841644102059556915">Invite TomoriBot</a></strong>
  &middot;
  <strong><a href="https://discord.gg/bjCfHm9QsB">Discord Server</a></strong>
  <br />
  <a href="https://github.com/Bredrumb/TomoriBot/releases">Latest Releases</a>
  &middot;
  <a href="https://github.com/Bredrumb/TomoriBot/issues/new?template=bug-report.md">Report Bug</a>
  &middot;
  <a href="https://github.com/Bredrumb/TomoriBot/issues/new?template=feature-request.md">Request Feature</a>
  <br />
  <br />

[![GitHub Stars](https://img.shields.io/github/stars/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/forks)
[![GitHub Issues](https://img.shields.io/github/issues/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/pulls)
[![License](https://img.shields.io/github/license/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/blob/main/LICENSE)


  </p>

  




<!-- PROJECT LOGO -->
![TomoriBot Banner](assets/img/tomobanner.png)
[![Bun][Bun.sh]][Bun-url][![Discord.js][Discord.js]][Discord-url][![TypeScript][TypeScript.js]][TypeScript-url][![PostgreSQL][PostgreSQL.org]][PostgreSQL-url]

  
</div>

<!-- ABOUT THE PROJECT -->
## About the Project

TomoriBot is a free and open-source self-hosted personal AI assistant and role-playing system for Discord, inspired by SillyTavern and Discord's discontinued Clyde. It can be used as a practical assistant, customizable companion, and role-play partner for yourself in DMs, or for everyone in your Discord server. 

TomoriBot supports long-term memory, multi-persona behavior, web and MCP tools, in-chat media generation, 200+ Discord slash commands, and multiple providers including custom proxies and self-hosting your own models for everything from text generation to video generation.

### Getting Started

You can [invite the public TomoriBot](https://discord.com/oauth2/authorize?client_id=841644102059556915) to your Discord server, or [self-host your own instance](#self-hosting) if you prefer full control over your privacy and API keys. TomoriBot uses best security practices and encryption that keeps data safe, but self-hosting ensures that all data remain entirely on your device. 

After adding her to your server through either method above, run the `/config setup` command for instructions. Then you can simply say her name (or @ mention her) in order to get a response. 

## Feature Showcase


![Screenshots 1](assets/img/scs/1.png)
<h3 align="center"><a href="https://docs.tomoribot.app/en/features/capabilities/tools-and-extensions/">Agentic AI-Powered Conversation</a></h3>
<p align="center">TomoriBot has LOTS of tools that allows her to go beyond just chatting, such as searching the web, setting recurrent tasks/reminders, utilizing your server's emotes/stickers, and memory options such as RAG and STM that allow her to remember context across channels and servers. </p>

<br />


![Screenshots 2](assets/img/scs/2.png)
<h3 align="center"><a href="https://docs.tomoribot.app/en/features/capabilities/media-generation/">Complete Multimodal Input/Output</a></h3>
<p align="center">TomoriBot can process images, audio, and video sent       
  directly in Discord and generate them in return using your own local model endpoints or through API keys, all of which are encrypted inside a persistent database. Ready-to-use ComfyUI workflows can be found in <code>assets/comfyui-workflows/</code> and local audio inference servers in <code>servers/</code>!</p>

<br />

![Screenshots 3](assets/img/scs/3.png)
<h3 align="center"><a href="https://docs.tomoribot.app/en/features/chatting-personality/multiple-personas/">Multi-Persona Support</a></h3>
<p align="center">TomoriBot's in-server personality, behavior, and avatar can be easily changed, created, as well as exported for others as Personas (akin to shareable AI Character Cards). Import and even transform your favorite SillyTavern cards through <code>/persona generate</code>. You can have an unlimited amount of different personas in a single server, each having their own memories and agendas. You can also orchestrate them to work with each other to do work in your server (or just mess around with each other).</p>

<br />


![Screenshots 4](assets/img/scs/4.png)
<h3 align="center"><a href="https://docs.tomoribot.app/en/features/command-reference/">200+ Native Commands for Configuration</a></h3>
<p align="center">Everything can be managed through Discord's native slash commands and interactive UI. Completely manage personas, prompts, tweak model parameters, set up MCP tool servers, adjust permissions, configure memory, set server member rate limits, and much more! You can also ask TomoriBot directly on what she can do and what her slash commands are. Currently, a Web Dashboard is in the works for even easier management.</p>

<br />


![Screenshots 6](assets/img/scs/6.png)

<h3 align="center"><a href="https://docs.tomoribot.app/en/features/integrations/sillytavern-support/">SillyTavern Integration (Beta)</a></h3>
<p align="center">Use your favorite SillyTavern presets directly in Discord through TomoriBot which adjusts her prompt completely, just plop the .json right in through <code>st-preset</code>. Discord's new native checkbox groups for modals makes it easy to toggle nodes on and off like in SillyTavern. You can also import SillyTavern character cards directly through <code>/persona import</code> or you can modify them first with <code>/persona generate</code>.</p>

![Screenshots 5](assets/img/scs/5.png)
<h3 align="center"><a href="https://docs.tomoribot.app/en/features/">Lots of More Features, and Counting!</a></h3>
<p align="center">A bunch of fun features that are easy to setup ranging from practical automatic greetings for new server members and cross-channel movement, to silly ones like user impersonations for some trolling. New ones are constantly in development, so please report through GitHub issues or the official Discord for any bugs (or to share any fun suggestions).</p>

## Useful Resources

### [Full List of Supported Providers](https://docs.tomoribot.app/en/features/setup-administration/providers-and-models/#supported-providers)
TomoriBot supports a wide range of LLM providers, image generation APIs, voice services, and search tools out of the box.

### [How to run Local Models](https://docs.tomoribot.app/en/self-hosting/local-endpoints/)

TomoriBot supports local LLMs (via KoboldCPP, LM Studio, vLLM, etc.), local image/video generation via ComfyUI, local TTS and STT endpoints, as well as local SearXNG and Browser web fetch Docker sidecars.

### [Security & Threat Models](https://docs.tomoribot.app/en/wiki/threat-models/)

TomoriBot employs encryption and security best practices to keep data and API keys completely safe, both for local setups as well as for those using the public deploy.

### [Tool Macros for Prompt Customization](https://docs.tomoribot.app/en/features/capabilities/tools-and-extensions/)

TomoriBot comes with a variety of built-in tools (such as web search, memory management, image generation, cross-channel messaging, and more), which you can directly refer to in your prompts with macros, here are some silly examples:

#### 1. Wellness Checker
```text
Every few hours, do a mandatory wellness check on @Bredrumb. 
Ask them how they feel right now and if they've taken a break from coding recently. 
Track their emotional state over time with {memory_tool} and/or {memory_update_tool} to report back to them later.
```
#### 2. Weekly ~~Current Events~~ Yuri News 
```text
Every Friday, compile the week's notable yuri manga chapters, anime episodes, and community fanart drops using {web_search_tool}. 
Present findings with {voice_message_tool} in a seductive ASMR voice.
```
#### 3. Sleep Police
```text
If you notice through {message_metadata_tool} that someone is chatting past 2 AM, use {voice_message_tool} to send them a threateningly calm ASMR lullaby telling them to go to bed. 
If they keep talking 10 minutes later, use {manage_message_tool} to delete their message for their own good and remind them that sleep deprivation is a leading cause of their issues.
```
### [Official TomoriBot Roadmap](https://github.com/users/Bredrumb/projects/1/views/1) 

Stay in the loop for TomoriBot's planned features as well as all known issues.


<!-- GETTING STARTED -->
## Self-Hosting

Choose one install path:

- **A. Local Bun Setup (Recommended):** requires Bun, Node.js v20+ for MCP tooling, and either PostgreSQL or Docker for the database.
- **B. Docker Compose Setup:** requires Docker only for running the bot/database, but host-side maintenance scripts still need host tooling.

The recommended path for most self-hosters is the local Bun setup wizard. Its default **Full Install** path creates `.env`, generates a safe `CRYPTO_SECRET`, asks for your Discord bot token, configures PostgreSQL, runs `bun install --frozen-lockfile`, then attempts the lightweight database and AI helper extras.

### A. Local Bun Setup

1. **Clone the repository**
   ```sh
   git clone https://github.com/Bredrumb/TomoriBot.git
   cd TomoriBot
   ```

2. **Run the setup wizard** (more info at **[Setup Wizard guide](https://docs.tomoribot.app/en/self-hosting/setup-wizard/)**)
   ```sh
   bun run setup
   ```

3. **Start TomoriBot**
    ```sh
    bun run dev
    ```

Once you see `TomoriBot up and running!`, run `/config setup` in Discord.

### B. Docker Compose Setup

Docker Compose builds and runs TomoriBot plus PostgreSQL. It does not use the setup wizard.

**Required `.env` variables for Docker Compose:**
- `DISCORD_TOKEN` - Your Discord bot token
- `CRYPTO_SECRET` - 32-character encryption key
- `POSTGRES_PASSWORD` - Database password (other DB settings are auto-configured)

For Docker Compose, start from `.env.example`, then add `POSTGRES_PASSWORD` if you have not already set it. Optional Docker or runtime tuning values can still be copied from `.env.optional.example`.

```sh
# Build and start TomoriBot and her database
docker compose up --build
```

For later starts, `docker compose up` is enough unless you changed code or dependencies.

### C. Optional Sidecars & Servers

TomoriBot supports opt-in sidecar/server services alongside either setup path to enhance her tools and add local monitoring: SearXNG for web search, Crawl4AI for browser-rendered page fetches, and local TTS/STT voice servers.

**With the local Bun setup (A)**, use `bun run launch` instead of `bun run dev`, example runs:

```sh
# With SearXNG and Crawl4AI Docker sidecars
bun run launch --searxng --crawl4ai

# With a local TTS server after following the voice setup docs
bun run launch --qwen3tts

# See all available flags
bun run launch --help
```

Available flags: `--searxng`, `--crawl4ai`, `--qwen3tts`, `--chatterbox`, `--irodoritts`, `--whisperx`, `--help`

**Ctrl+C** stops the bot and any Python sidecar processes. Docker containers (`--searxng`, `--crawl4ai`) are intentionally left running, stop them manually with `docker stop searxng` / `docker stop crawl4ai` when you're done.

**With Docker Compose (B)**, sidecars are opt-in via Compose profiles instead:

```sh
# + SearXNG web search (self-hosted metasearch)
docker compose --profile searxng up

# + Crawl4AI browser-rendered page fetching
docker compose --profile fetch-crawl4ai up

# + Both at once
docker compose --profile searxng --profile fetch-crawl4ai up
```

See the guides below for full setup details:

- **[SearXNG Web Search Sidecar](https://docs.tomoribot.app/en/self-hosting/local-endpoints/setup-searxng/)** - A self-hosted metasearch instance to bypass single-engine API limits for the `web_search` tool.
- **[Crawl4AI Sidecar](https://docs.tomoribot.app/en/self-hosting/local-endpoints/setup-crawl4ai/)** - A browser-rendering sidecar to fetch and process JavaScript-heavy webpages for the `fetch_url` tool.
- **[Text-to-Speech](https://docs.tomoribot.app/en/self-hosting/local-endpoints/text-to-speech/)** / **[Speech-to-Text](https://docs.tomoribot.app/en/self-hosting/local-endpoints/speech-to-text/)** - Python voice servers for TomoriBot's voice messages; their venv must be set up once beforehand.

### Updating TomoriBot

To update your self-hosted instance to the latest version, stop the bot first (so the backup and any migrations run against a quiet database), then run the backup-first updater:

```sh
bun run update
```

The command runs this sequence, stopping immediately if any step fails:

1. **`bun run backup`** - takes a full database backup into `/backups/` *before* touching any code. If the backup fails, the update aborts with your deployment completely unchanged.
2. **`git pull --rebase --autostash`**
3. **`bun install --frozen-lockfile`**

Then restart TomoriBot with `bun run dev` or `bun run launch`

Useful flags:

| Flag | Effect |
|---|---|
| `--build` | Also runs `bun run build` after installing dependencies |
| `--docker` | Docker Compose path: replaces step 3 with `docker compose build` + `docker compose up -d` |
| `--skip-backup` | Skips the pre-update backup (not recommended) |
| `--yes` | Skips the confirmation prompt before starting |

See the full **[Maintenance Documentation](https://docs.tomoribot.app/en/features/command-reference/)** for more details on all host-side scripts.

<!-- AFTER SETUP -->
### After Inviting / Setup

#### Basic Commands

- `/config setup` - Initial bot setup for your server
- `/config` - Multiple ways to tweak TomoriBot
- `/memory personal add` / `/memory personal remove` - Add / remove your personal memories
- `/memory server add` / `/memory server remove` - Add / remove server-wide memories
- `/server whitelist` / `/server user-blacklist` - Add / remove permissions from TomoriBot

See the full **[Command Reference](https://docs.tomoribot.app/en/features/command-reference/)** for every slash command.

#### Chat Interaction

Simply mention the bot in a server or use the configured trigger words to start a conversation:
```
@TomoriBot yo wassup
```

Or slide into TomoriBot's DMs and say hi!

<!-- CONTRIBUTING -->
## Contributing

Contributions to TomoriBot are greatly appreciated! Please review the following resources before opening a pull request:

- **[Contributing Documentation](https://docs.tomoribot.app/en/contributing/)**: Comprehensive step-by-step guides for adding slash commands, tools, event handlers, new AI providers, and locales.
- **[Contributing Guidelines](.github/CONTRIBUTING.md)**: Repository rules covering branching, quality gate checks, and the scope of contributions welcomed without prior discussion.

<!-- LEGAL -->
## Legal & License

### For users of the official hosted TomoriBot instance
- **[Terms of Service](https://docs.tomoribot.app/en/legal/terms-of-service/)** - Rules and guidelines for using the bot
- **[Privacy Policy](https://docs.tomoribot.app/en/legal/privacy-policy/)** - How we handle your data

These documents are also accessible within Discord using `/legal terms` and `/legal privacy` commands.

### For users self-hosting or using forks
You control your own data and are responsible for your deployment's compliance under the [**GNU Affero General Public License v3.0**](https://github.com/Bredrumb/TomoriBot/blob/main/LICENSE).

<!-- CONTACT -->
## Contact & Links

**Official Website**: [https://docs.tomoribot.app](https://docs.tomoribot.app/)

**Project Link**: [https://github.com/Bredrumb/TomoriBot](https://github.com/Bredrumb/TomoriBot)

**Email**: bredrumb@gmail.com

**Discord**: [Official Support Server](https://discord.gg/bjCfHm9QsB)

<!-- SUPPORT -->
## Support the Project

If you find TomoriBot helpful and want to support its ongoing development, consider leaving a ⭐ on GitHub or supporting via Ko-fi!

<p align="left">

  &nbsp;
  <a href="https://ko-fi.com/bredrumb">
    <img src="https://img.shields.io/badge/Support_on_Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Support on Ko-fi">
  </a>
</p>

<!-- MARKDOWN LINKS & IMAGES -->
[TypeScript.js]: https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Bun.sh]: https://img.shields.io/badge/Bun-f472b6?style=for-the-badge&logo=bun&logoColor=white
[Bun-url]: https://bun.sh/
[Discord.js]: https://img.shields.io/badge/Discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white
[Discord-url]: https://discord.js.org/
[PostgreSQL.org]: https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white
[PostgreSQL-url]: https://www.postgresql.org/
[Google.ai]: https://img.shields.io/badge/Google%20AI-4285F4?style=for-the-badge&logo=google&logoColor=white
[Google-url]: https://ai.google.dev/
