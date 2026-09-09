---
title: "Setup: Local MCP Server"
sidebar:
  order: 6
---

[MCP](https://modelcontextprotocol.io/) servers extend TomoriBot with external tools. Online
(HTTPS) MCP servers work on any instance — see
[Tools & Extensions](/features/capabilities/tools-and-extensions/#mcp-servers). **Local** MCP servers are
different:

:::caution[Self-hosting only]
Local MCP servers are **only supported on self-hosted instances**. The public hosted bot
requires HTTPS and blocks local/private addresses for security, so it can't reach a server on
`localhost` or your LAN.
:::

## 1. Run a local MCP server

Start any MCP server that exposes an HTTP/SSE transport on a local port. For example, many
MCP servers run via Node:

```sh
npx -y <some-mcp-server> --port 3000
```

The exact command depends on the server you're running. Note the URL and transport path it
prints — commonly something like `http://localhost:3000/sse`.

TomoriBot's own tooling expects **Node.js v20+** to be available for MCP tooling on the host.

## 2. Register it in Discord

Open `/config` > Plugins > MCP Servers (or `/mcps`), choose **+ Add MCP**, point the **URL** field
at your local server, and leave the required **Server Type** on its default **General Purpose** value:

```text
http://localhost:3000/sse
```

Leave the **Auth Token** field blank — no auth token is needed for local servers.

## 3. Manage it

- Open the Config page (or `/mcps`) and choose **Remove** on the server's row. Confirming unregisters it,
  immediately disconnects it, and frees a slot.

## Security

:::danger[Only add MCP servers you trust]
Even a local server you run yourself can misbehave if its code is untrusted. A malicious MCP
server can prompt-inject the model, exfiltrate data passed to its tools, or return harmful
results TomoriBot will relay. Review what an MCP server does before wiring it up.
:::

For the online-MCP flow and the full security rationale, see
[Tools & Extensions → MCP Servers](/features/capabilities/tools-and-extensions/#mcp-servers).
