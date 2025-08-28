# DuckDuckGo & Felo AI Search MCP Server 🔍🧠

A blazing-fast, privacy-friendly Model Context Protocol (MCP) server for web search and AI-powered responses using DuckDuckGo and Felo AI.

This comprehensive MCP server provides advanced search and content extraction capabilities through:

- **Web Search**: Enhanced DuckDuckGo HTML scraping for comprehensive results
- **AI Search**: Felo AI integration for intelligent, contextual responses
- **URL Content Extraction**: Smart filtering and content retrieval from any web page
- **URL Metadata Extraction**: Structured metadata including title, description, and images
- **Zero API Keys Required**: Works out of the box with NPX

## ✨ Key Features

✅ **Privacy-First**: No tracking, no personal data collection  
✅ **AI-Powered**: Intelligent responses via Felo AI integration  
✅ **Comprehensive**: 4 specialized tools for different search needs  
✅ **Performance**: Optimized with caching and rate limiting  
✅ **Security**: Rotating user agents and smart filtering  
✅ **Zero Setup**: No API keys or configuration required  

## 🧰 Available Tools

### 1. Web Search Tool (`web-search`)
Enhanced DuckDuckGo web search with HTML scraping for comprehensive results.

**Parameters:**
- `query` (string, required): The search query
- `page` (integer, optional, default: 1): Page number  
- `numResults` (integer, optional, default: 12): Number of results (1-20)

**Features:**
- Comprehensive web scraping vs limited API results
- Automatic fetch capability reminders for found URLs
- Enhanced result formatting with source attribution

### 2. Felo AI Search Tool (`felo-search`)
AI-powered search providing intelligent, contextual answers to user queries.

**Parameters:**
- `query` (string, required): The search query or prompt
- `stream` (boolean, optional, default: false): Whether to stream the response

**Features:**
- Context-aware AI responses
- Intelligent query interpretation  
- Enhanced with source attribution when available

### 3. URL Content Extraction Tool (`fetch-url`)
Smart web page content extraction with filtering and optimization.

**Parameters:**
- `url` (string, required): The URL to fetch
- `maxLength` (integer, optional, default: 15000): Max content length
- `extractMainContent` (boolean, optional, default: true): Extract main content
- `includeLinks` (boolean, optional, default: true): Include link text
- `includeImages` (boolean, optional, default: true): Include image alt text
- `excludeTags` (array, optional): HTML tags to exclude

**Features:**
- Smart content filtering and extraction
- Automatic truncation with metadata suggestions
- Cross-references with metadata extraction tool

### 4. URL Metadata Extraction Tool (`url-metadata`)
Structured metadata extraction including OpenGraph, Twitter Cards, and standard meta tags.

**Parameters:**
- `url` (string, required): The URL to extract metadata from

**Features:**
- Complete metadata extraction (title, description, images, etc.)
- OpenGraph and Twitter Card support
- Cross-references with content fetching tool

## 🚀 Performance & Security Features

- **Intelligent Caching**: Reduced response times for repeated queries
- **Rate Limiting**: Built-in protection against abuse
- **Rotating User Agents**: Enhanced privacy and reliability  
- **Smart Content Filtering**: Optimized content extraction
- **Error Handling**: Comprehensive error recovery and logging

## 🚀 Quick Start

Run instantly with NPX (no installation required):

```bash
npx -y @oevortex/ddg_search@latest
```

> **Tip**: This downloads and runs the latest version directly – perfect for quick use with AI assistants!

## 🛠️ Installation Options

### Global Installation
```bash
npm install -g @oevortex/ddg_search
```

Run globally:
```bash
ddg-search-mcp
```

### Local Development
```bash
git clone https://github.com/OEvortex/ddg_search.git
cd ddg_search
npm install
npm start
```

## 🤖 Integration with MCP Clients

### TomoriBot Configuration
This server is pre-configured in TomoriBot and ready to use! The configuration includes:

- **Package**: `@oevortex/ddg_search@latest`
- **Transport**: NPX with auto-installation
- **Status**: Enabled by default
- **Category**: Search tools

### Manual MCP Client Setup

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "duckduckgo-search": {
      "command": "npx",
      "args": ["-y", "@oevortex/ddg_search@latest"]
    }
  }
}
```

Or if installed globally:
```json
{
  "mcpServers": {
    "duckduckgo-search": {
      "command": "ddg-search-mcp"
    }
  }
}
```

> **Note**: After configuration changes, restart your MCP client to apply the settings.

## 🧪 Usage Examples

### Web Search Example
```javascript
// Search for "climate change solutions"
web-search({
  query: "climate change solutions",
  numResults: 10,
  page: 1
})
```

### AI Search Example  
```javascript
// Get AI-powered explanation
felo-search({
  query: "Explain quantum computing in simple terms",
  stream: false
})
```

### URL Content Extraction Example
```javascript
// Extract full webpage content
fetch-url({
  url: "https://example.com/article",
  maxLength: 20000,
  extractMainContent: true,
  includeLinks: true
})
```

### URL Metadata Example
```javascript
// Get structured page metadata
url-metadata({
  url: "https://example.com/article"
})
```

## 🔧 Advanced Configuration

### Parameter Optimization
The TomoriBot integration includes optimized defaults:

- **Web Search**: 12 results per query (balanced performance)
- **Felo AI**: Streaming disabled for Discord compatibility
- **URL Fetch**: 15KB content limit with smart truncation
- **Metadata**: No overrides (URL is the only parameter)

### Cross-Tool Integration
Tools work together seamlessly:

- **Web Search** → **Fetch URL**: Extract full content from search results
- **Web Search** → **URL Metadata**: Get structured metadata for results
- **URL Fetch** → **URL Metadata**: Combine content and metadata analysis
- **Felo AI**: Can reference and analyze content from other tools

## 🛡️ Privacy & Security

- **No API Keys Required**: Zero configuration, instant setup
- **Privacy-First**: No tracking or personal data collection
- **Rate Limited**: Built-in protection against abuse
- **User Agent Rotation**: Enhanced reliability and privacy
- **Error Handling**: Comprehensive logging and recovery

## 📊 Performance Benefits

- **Enhanced HTML Scraping**: More comprehensive than limited API results
- **Intelligent Caching**: Faster repeated queries
- **Smart Content Filtering**: Optimized content extraction
- **Concurrent Processing**: Multiple tools can run simultaneously
- **Resource Optimization**: Automatic content length management

## 🐛 Debugging & Troubleshooting

### Common Issues
1. **NPX Download Delays**: First run may take longer due to package download
2. **Rate Limiting**: Excessive requests may be temporarily blocked
3. **Content Truncation**: Adjust `maxLength` parameter for longer content

### Debug Mode
Enable debug logging in TomoriBot for detailed MCP communication:
```bash
# View MCP server logs
bun run dev
```

### MCP Inspector (Advanced)
For deep debugging, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
```bash
npx @modelcontextprotocol/inspector npx -y @oevortex/ddg_search@latest
```