<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/Eliolocin/TomoriBot">
    <img src="img/tomoricon.png" alt="Logo" width="80" height="80">
  </a>

<h3 align="center">TomoriBot (WORK IN PROGRESS)</h3>

  <p align="center">
    A customizable AI assistant (or waifu) for Discord featuring editable memory, personality switching, smart autonomous tool usage, and much more!
      <br />
        <br />
      <a href="https://github.com/Eliolocin/TomoriBot"><strong>EXPLORE THE WIKI »</strong></a>
      <br />
      <br />
      <a href="https://github.com/Eliolocin/TomoriBot/releases">View Releases</a>
      &middot;
      <a href="https://github.com/Eliolocin/TomoriBot/issues/new?labels=bug&template=bug-report---.md">Report Bug </a>
      &middot;
      <a href="https://github.com/Eliolocin/TomoriBot/issues/new?labels=enhancement&template=feature-request---.md"> Request Feature</a>
  </p>
</div>

![TomoriBot Banner](img/tomobanner.png)

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#configuration">Configuration</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

TomoriBot is a Discord chatbot built with TypeScript and Bun, featuring AI-powered conversations using various AI Providers such as Google's Gemini. 

Tomori provides an interactive and customizable chat experience with memory retention, expressions, multi-language support, and personality switching capabilities.

### Key Features
* 🤖 **AI-Powered Chat**: Advanced conversational AI using Large Language Models
* 🧠 **Memory System**: Persistent user and server memory for contextual conversations
* 🗿 **Emoji/Sticker Expressions**: Uses function calls to send your favorite Server Stickers and Emojis
* 👁️ **Computer Vision**: Utilizes Gemini API to see images and videos in Discord chats
* 🔍 **Search Grounding**: Searches the Internet for latest information
* 🌐 **Multi-Language Support**: Built-in internationalization with Japanese and English support
* 🎭 **Personality Switching**: Configurable personas and behavioral presets
* ⚙️ **Highly Configurable**: Extensive settings for customizing bot behavior
* 📊 **PostgreSQL Database**: Robust data persistence and user management
* 🔧 **Slash Commands**: Modern Discord interaction system with comprehensive command structure

### Built With

* [![TypeScript][TypeScript.js]][TypeScript-url]
* [![Bun][Bun.sh]][Bun-url]
* [![Discord.js][Discord.js]][Discord-url]
* [![PostgreSQL][PostgreSQL.org]][PostgreSQL-url]

<!-- GETTING STARTED -->
## Getting Started

This guide will help you set up TomoriBot locally for development or personal use.

### Prerequisites

Before running TomoriBot, ensure you have the following installed:

* **Bun** - JavaScript runtime and package manager
  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```
* **PostgreSQL** - Database server
  ```sh
  # Windows (using Chocolatey)
  choco install postgresql
  
  # macOS (using Homebrew)
  brew install postgresql
  
  # Linux (Ubuntu/Debian)
  sudo apt-get install postgresql postgresql-contrib
  ```
  - After installing PostgreSQL, login:
  ```sh
  # Linux
   sudo -u postgres psql
   
   # macOS (Homebrew)
   psql postgres
   
   # Windows
   # Use "SQL Shell (psql)" from Start Menu or:
   psql -U postgres
  ```
  - Create the required database and user for TomoriBot. Replace `your_` variables with your own and take note of them:
  ```sql
  CREATE USER your_username WITH PASSWORD 'your_password';
  CREATE DATABASE your_dbname;
  GRANT ALL PRIVILEGES ON DATABASE your_dbname TO your_username;
  \q
  ```

### Installation

1. **Clone the repository**
   ```sh
   git clone https://github.com/Eliolocin/TomoriBot.git
   cd TomoriBot
   ```

2. **Install dependencies**
   ```sh
   bun install
   ```

### Configuration

**Create environment file** `.env` and then fill in the required variables:
   ```
    # Discord Bot Configuration (Required)
    DISCORD_TOKEN=your_discord_bot_token_here

    # Security (Required)
    CRYPTO_SECRET=your_32_character_crypto_secret_here

    # Database Configuration (Required)
    POSTGRES_HOST=localhost
    POSTGRES_PORT=5432
    POSTGRES_USER=your_username
    POSTGRES_PASSWORD=your_password
    POSTGRES_DB=your_dbname

    # Bot Configuration (Optional)
    DEFAULT_BOTNAME=Tomori
    DEFAULT_BOTNAME_JP=ともり
    BASE_TRIGGER_WORDS=tomori,tomo,トモリ,ともり
   ```


<!-- USAGE EXAMPLES -->
## Usage

### Starting the Bot

There are two ways to start the bot, both of which uses your local `.env` file.

#### Launching with Bun
```sh
# Development mode with hot reload
bun run dev
```

#### Launching with Docker Compose
```sh
# Build TomoriBot's container (first time or after code changes)
docker compose build

# Start TomoriBot and her database
# For the database of the Docker version, local '.env' only needs POSTGRES_PASSWORD variable
docker compose up
```

### Basic Commands

- `/config setup` - Initial bot setup for your server
- `/config` - Multiple ways to tweak TomoriBot
- `/teach` - Add memories for TomoriBot
- `/unlearn` - Remove memories from TomoriBot
- `/serverconfig` - Add / Remove permissions from TomoriBot

### Chat Interaction

Simply mention the bot in a server or use the configured trigger words to start a conversation:
```
@TomoriBot yo wassup
```

Or slide into TomoriBot's DMs and say hi!

<!-- ROADMAP -->
## Roadmap

- [x] Core AI chat functionality
- [x] Multi-language support
- [x] Memory system implementation
- [x] Slash command structure
- [ ] Voice channel integration
- [ ] Image generation capabilities
- [ ] Web dashboard for configuration

See the [open issues](https://github.com/Eliolocin/TomoriBot/issues) for a full list of proposed features and known issues.


<!-- CONTRIBUTING -->
## Contributing

Any contributions made  are **greatly appreciated**.

If you have a suggestion that would make TomoriBot better, please fork the repo and create a pull request. You can also simply open an issue with the tag "Enhancement".


<!-- LICENSE -->
## License

Distributed under the GPL License. See `LICENSE` for more information.

<!-- CONTACT -->
## Contact

Project Link: [https://github.com/Eliolocin/TomoriBot](https://github.com/Eliolocin/TomoriBot)


<!-- MARKDOWN LINKS & IMAGES -->
[TypeScript.js]: https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Bun.sh]: https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white
[Bun-url]: https://bun.sh/
[Discord.js]: https://img.shields.io/badge/Discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white
[Discord-url]: https://discord.js.org/
[PostgreSQL.org]: https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white
[PostgreSQL-url]: https://www.postgresql.org/
[Google.ai]: https://img.shields.io/badge/Google%20AI-4285F4?style=for-the-badge&logo=google&logoColor=white
[Google-url]: https://ai.google.dev/
