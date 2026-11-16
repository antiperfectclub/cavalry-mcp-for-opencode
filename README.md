# Cavalry MCP

> **Modified fork — generic, host-agnostic wrapper (not Claude Code-specific).**
> This repository is a personal, convenience-only repackaging of the official
> **Cavalry by Canva** MCP extension. The upstream extension, its behaviour, tool
> surface, bundled docs and privacy scope are unchanged; only the MCP-host
> configuration roots (the client entry points that launch this server) have been
> re-pointed from a single Claude-oriented client to generic hosts — **OpenCode,
> Antigravity, VS Code (Copilot), Zed**, etc. All support, maintenance and
> liability for the extension remain with Canva and Cavalry. See
> [Disclaimer & copyright](#disclaimer--copyright).

Drive Cavalry from an LLM. The extension exposes Cavalry's JavaScript scripting API to MCP hosts (OpenCode, Antigravity, VS Code, Zed, Claude Desktop, ChatGPT, …) via an MCP server.

This repo packages the Node.js stdio↔SSE bridge that the host launches. The actual MCP server runs in-process inside Cavalry, served over HTTP/SSE on `localhost:6768`.

## Architecture

```
MCP host        <--stdio-->  this Node bridge  <--SSE-->  Cavalry app
(OpenCode, Antigravity, VS Code, Zed, …)                  (port 6768)
```

The bridge connects to Cavalry lazily — the first tool call opens the connection; listing tools/resources/prompts never does. It forwards the host's identity (from the stdio `initialize` handshake) to Cavalry in `X-Cavalry-MCP-Client-Name`/`-Version` headers, which is what labels the MCP pill in Cavalry's message bar.

## Authentication

On the first connection for a given host, the bridge generates a 256-bit fingerprint and stores it at `~/.cavalry-mcp/fingerprint-<host>` (mode `0600`) — one file **per host** (e.g. `fingerprint-claude-desktop`), so each LLM app gets its own approval, its own row in Cavalry's MCP popover, and its own disconnect. Every connection to Cavalry sends it as the `X-Cavalry-MCP-Fingerprint` header, so Cavalry can recognise the same client across restarts.

A connection from an unapproved fingerprint blocks on Cavalry's approval dialog (401/403 if denied). Until the user clicks Allow, tool calls return an error telling them to switch to Cavalry and approve.

## Privacy Policy

Canva's privacy policy applies to Cavalry by Canva and to this extension: <https://www.canva.com/policies/privacy-policy/>

### What the extension collects

The bridge collects no analytics, telemetry or usage data, and makes no network requests other than to Cavalry on `localhost`.

The only data it writes is the per-host connection secret described under [Authentication](#authentication), at `~/.cavalry-mcp/fingerprint-<host>` (directory mode `0700`, file mode `0600`). It holds a locally generated random 256-bit value, and nothing about you, your scenes, or your MCP host beyond that host's name in the filename.

### What leaves your device

Tool results are returned to whichever MCP host you installed the extension in, and that host sends them on to its own model provider under that provider's terms. Depending on which tools are called, those results can include your scene's structure and layer values, the output of scripts run against it, the contents of scripts in your Cavalry script library, and PNG renders of a layer or composition produced by `snapshot_layer`. Cavalry by Canva has no visibility into, or control over, what the host does with them.

Separately, when you are signed in to your Canva account in Cavalry by Canva, `execute_script` sends the script text to Canva's intelligence-broker service for an automated malicious-code assessment before running it, together with your Canva access token and user ID. The assessment itself is performed by a third-party inference provider that Canva engages as a sub-processor, so the script text reaches that provider too. This is the same check Cavalry applies to scripts run from its Scripts menu. When you are signed out or offline, no request is made and the script runs unchecked.

Aside from that check, the MCP server listens only on `localhost` and makes no outbound connections. Your scenes are never uploaded to Canva or to any other server.

### Storage and retention

- **Connection secret** — persists at the path above until you delete it. Remove the file and the next connection is treated as new, raising the approval dialog again.
- **Connection approvals** — held in memory only, and discarded when Cavalry quits.
- **Script text sent for assessment** — held by the intelligence-broker service only for as long as the assessment takes, and not retained afterwards. The service records usage, but those logs contain no user assets.
- **Malicious-code verdicts** — cached AES-encrypted in Cavalry's preferences, keyed by a SHA-256 hash of the script text. The script text itself is not stored.
- **Saved scripts** — `save_script_to_library` writes to Cavalry's user scripts folder (`<application data>/Scripts`), where they stay until you delete them.
- **Scratch files** — scripts may write working files into a `cavalry-mcp-…` session folder in your system temp directory. `cleanup_workspace` removes them, and your operating system clears the temp directory in any case.

Snapshots are returned inline in the tool result and are never written to disk.

### Third-party sharing

Data is shared along the two paths described above, and no others:

- **Your chosen MCP host**, which passes tool results on to its own model provider under that provider's terms.
- **Canva's intelligence-broker service**, which passes script text to a third-party inference provider engaged by Canva as a sub-processor. Canva's current sub-processors are listed at <https://www.canva.com/policies/subprocessors/>.

### Contact

Questions about this extension: <support@cavalry.studio>

Privacy enquiries and data requests: <privacy@canva.com>, or Head of Privacy, Canva Pty Ltd, 110 Kippax St, Surry Hills NSW 2010, Australia. EU and UK representatives are listed in the policy linked above.

## Tools

| Tool | Purpose |
|------|---------|
| `read_preamble` | System-prompt-style guide. Required reading before `execute_script`. |
| `execute_script` | Run JavaScript against the open Cavalry scene. |
| `preflight_script` | Compile-only syntax check. |
| `preflight_shader` | Compile-check SkSL shader/filter source without installing it. |
| `cleanup_workspace` | Delete scratch files a session created under Cavalry's temp folder. |
| `list_library_scripts` | List user's saved scripts. |
| `read_library_script` | Read a saved script. |
| `save_script_to_library` | Save a completed script for later re-use. |
| `search_api` | Search Cavalry's JavaScript API metadata. |
| `get_api_function` | Full definition of one API function or property. |
| `search_docs` | Full-text search over bundled Cavalry documentation. |
| `read_doc` | Read one documentation page by path. |
| `search_layer_types` | Search available layer types by name/attribute/tooltip. |
| `get_layer_definition` | Full attribute list for a layer type. |
| `search_examples` | Search bundled example preset scenes. |
| `read_example` | Read the full source of an example preset. |
| `snapshot_layer` | Render a layer or comp to PNG for visual inspection. |

## Development

```sh
npm install
node server/index.js   # starts the bridge; expects Cavalry running with MCP enabled
```

## Packaging

```sh
npx @anthropic-ai/mcpb pack .
```

Produces `cavalry-mcp-server.mcpb` for distribution.

## Setup

1. Open Cavalry. The MCP server is on by default; Preferences has the toggle and the port if you need them.
2. Point your MCP client at this server (pick your client below).
3. Ask your LLM client to do something in Cavalry.
4. Switch to Cavalry and accept the connection.

The bridge is a stdio MCP server that talks to Cavalry over SSE at
`http://localhost:6768/sse`. Every host entry below launches `server/index.js`
with `SSE_URL` set to that address; replace `<path-to>` with the absolute path to
this repository.

### VS Code (Copilot) — `.vscode/mcp.json`

```json
{
  "servers": {
    "cavalry": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to>/cavalry-mcp-server/server/index.js"],
      "env": { "SSE_URL": "http://localhost:6768/sse" }
    }
  }
}
```

### Zed — `.zed/settings.json` (or `~/.config/zed/settings.json`)

```json
{
  "context_servers": {
    "cavalry": {
      "source": "custom",
      "command": "node",
      "args": ["<path-to>/cavalry-mcp-server/server/index.js"],
      "env": { "SSE_URL": "http://localhost:6768/sse" }
    }
  }
}
```

### OpenCode — `opencode.json`

```json
{
  "mcp": {
    "cavalry": {
      "type": "local",
      "command": ["node", "<path-to>/cavalry-mcp-server/server/index.js"],
      "enabled": true,
      "environment": { "SSE_URL": "http://localhost:6768/sse" }
    }
  }
}
```

### Antigravity — `mcp_config.json`

Add a `stdio` entry under `mcpServers` (App: **Customizations → MCP Servers**; the
same schema is used by the CLI/IDE and `.agents/mcp_config.json`):

```json
{
  "mcpServers": {
    "cavalry": {
      "command": "node",
      "args": ["<path-to>/cavalry-mcp-server/server/index.js"],
      "env": { "SSE_URL": "http://localhost:6768/sse" }
    }
  }
}
```

## Disclaimer & copyright

This repository is a **modified fork** of the official Cavalry MCP extension,
repackaged for the fork author's personal convenience. The author changed only
the MCP-host configuration wrapper (the client roots that launch this server —
OpenCode, Antigravity, VS Code, Zed, …) to suit their own setup; the underlying
extension is untouched upstream code.

- **Ownership** — the base extension, its source, tools, bundled documentation,
  examples and privacy policy are owned by **Canva** and **Cavalry** (Cavalry
  Studios). Apart from the wrapper changes described above, **all copyright and
  other intellectual-property rights in this repository belong to Canva and
  Cavalry**.
- **Management** — all maintenance, updates, support, security and liability for
  the extension remain with Canva and Cavalry. The fork's author provides no
  support and accepts **no responsibility or liability** for this fork, its
  modifications, its fitness for any purpose, or any loss or damage arising from
  its use. Use it at your own risk.
- **Contact** — extension questions: <support@cavalry.studio>; privacy enquiries:
  <privacy@canva.com> (see the [Privacy Policy](#privacy-policy) above).
