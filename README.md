<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/Eliolocin/TomoriBot">
    <img src="img/tomoricon.png" alt="Logo" width="80" height="80">
  </a>

<h3 align="center">TomoriBot (WORK IN PROGRESS)</h3>

  <p align="center">
    A customizable, AI Discord chatbot with memory and personality switching
    <br />
    <a href="https://github.com/Eliolocin/TomoriBot"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://github.com/Eliolocin/TomoriBot/issues/new?labels=bug&template=bug-report---.md">Report Bug</a>
    &middot;
    <a href="https://github.com/Eliolocin/TomoriBot/issues/new?labels=enhancement&template=feature-request---.md">Request Feature</a>
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

TomoriBot is a Discord chatbot built with TypeScript and Bun, featuring AI-powered conversations using Google's Gemini models. It provides an interactive and customizable chat experience with memory retention, expressions, multi-language support, and personality switching capabilities.

### Key Features
* 🤖 **AI-Powered Chat**: Advanced conversational AI using Google Gemini models
* 🧠 **Memory System**: Persistent user and server memory for contextual conversations
* 🗿 **Emoji/Sticker Expressions**: Uses function calls to send your custom Server Stickers and Emojis
* 👁️ **Computer Vision**: Utilizes Gemini API to see images in Discord chats
and Emojis
* 🔍 **Search Grounding**: Searches the Internet for latest information
* 🌐 **Multi-Language Support**: Built-in internationalization with Japanese and English support
* 🎭 **Personality Switching**: Configurable personas and behavioral presets
* ⚙️ **Highly Configurable**: Extensive settings for customizing bot behavior
* 📊 **PostgreSQL Database**: Robust data persistence and user management
* 🔧 **Slash Commands**: Modern Discord interaction system with comprehensive command structure

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![TypeScript][TypeScript.js]][TypeScript-url]
* [![Bun][Bun.sh]][Bun-url]
* [![Discord.js][Discord.js]][Discord-url]
* [![PostgreSQL][PostgreSQL.org]][PostgreSQL-url]
* [![Google AI][Google.ai]][Google-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

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

1. **Create environment file**
   
   Fill in the required variables on your `.env` file:
   ```env
   # Discord Bot Configuration (Required)
   DISCORD_TOKEN=your_discord_bot_token_here
   
   # Security (Required)
   CRYPTO_SECRET=your_32_character_crypto_secret_here
   
   # Database (Required)
   POSTGRES_URL=postgresql://username:password@localhost:5432/tomodb
   
   # Bot Configuration (Optional)
   DEFAULT_BOTNAME=Tomori
   DEFAULT_BOTNAME_JP=ともり
   BASE_TRIGGER_WORDS=tomori,tomo,トモリ,ともり
   RUN_ENV=development
   ```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->
## Usage

### Starting the Bot

```sh
# Development mode with hot reload
bun run dev
```

### Basic Commands

- `/config setup` - Initial bot setup for your server
- `/tool ping` - Check bot responsiveness
- `/teach personalmemory` - Add personal memories for the AI
- `/config preset` - Switch between different personality presets

### Chat Interaction

Simply mention the bot or use the configured trigger words to start a conversation:
```
@TomoriBot yo wassup
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

- [x] Core AI chat functionality
- [x] Multi-language support
- [x] Memory system implementation
- [x] Slash command structure
- [ ] Voice channel integration
- [ ] Image generation capabilities
- [ ] Advanced personality training
- [ ] Web dashboard for configuration

See the [open issues](https://github.com/Eliolocin/TomoriBot/issues) for a full list of proposed features and known issues.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the GPL License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

Project Link: [https://github.com/Eliolocin/TomoriBot](https://github.com/Eliolocin/TomoriBot)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

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
