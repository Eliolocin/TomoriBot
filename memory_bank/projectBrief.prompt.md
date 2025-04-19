# TomoriBot
 A Discord-based AI chatbot with dynamic personality, memory, and DevOps-focused modular architecture.

## 🎯 Project Summary
TomoriBot is a highly customizable Discord bot powered by Large Language Models (LLMs). Users can personalize her behavior, personality, memory, and language, making her adaptable for both **roleplaying** and **practical use** in community servers.

She is designed to be modular, developer-friendly, and easily deployable—ideal for experimenting with personality-driven AI interaction in social spaces.

## 💡 Core Features
- Slash command support (`/personality`, `/memory`, `/status`, etc.)
- Server- and user-based memory storage
- Personality presets and editing
- Language preference per user
- Admin-only configuration (e.g., model selection, API keys)
- TomoCoins economy system (with reward/penalty integration)
- Lightweight image gen/scraping support
- CI/CD ready and DevOps-aligned project layout

## 👥 Target Users
- Discord server owners who want an interactive, helpful, or roleplay-capable AI bot
- Users interested in customizing AI personalities for social and community interaction
- Developers and tinkerers experimenting with LLMs, memory systems, and chatbot UX

## 🔧 Tech Stack
- **Bun** as the runtime and tooling manager
- **Discord.js** for bot-client interaction
- **PostgreSQL** as the primary database (migrating from MongoDB)
- **LLM API integration** (OpenAI, Claude, etc.)
- **GitHub Actions** for CI/CD pipelines and linting
- **Markdown-based prompt memory system** for Copilot assistant usage

## 📦 Project Core Structure (High-Level Overview)
root/
├── src/
│   ├── db/
│   ├── events/     --- Discord events 
│   ├── handlers/   --- Discord event handler    
│   ├── locales/
│   ├── slash_commands/
│   │   ├── economy
│   │   ├── fun
│   │   ├── scrape
│   │   └── tool
│   ├── types/
│   ├── utils/
│   └── index.ts
├── memory_bank/
│   ├── projectBrief.prompt.md
│   ├── projectRequirements.prompt.md
│   ├── activeContext.prompt.md
│   └── systemPatterns.prompt.md
├── .github/
│   └── workflows/
├── .env
└── README.md


## 🧭 Project Goals
- Build a **Minimal Viable Product (MVP)** during Spring Vacation
- Practice clean **CI/CD DevOps** pipelines and good code hygiene
- Enable **user-led customization** of memory and personality features
- Support ongoing modular feature expansion without tech debt
