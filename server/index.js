#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CallToolResultSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Header values must be printable ASCII; Cavalry clamps and re-sanitises on
// its side too, this just keeps the HTTP layer happy.
function headerSafe(value) {
    return String(value || "").replace(/[^\x20-\x7e]/g, "").slice(0, 64);
}

// One fingerprint file PER HOST (Claude Desktop, ChatGPT, ...).
// Loaded lazily (not at startup) because the host's identity is only
// known after the stdio initialize.
const fingerprintCache = new Map();

function fingerprintFor(clientName) {
    const slug = ((clientName || "default").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default").slice(0, 40);
    if (fingerprintCache.has(slug)) {
        return fingerprintCache.get(slug);
    }
    const dir = join(homedir(), ".cavalry-mcp");
    const file = join(dir, "fingerprint-" + slug);
    let token = "";
    try {
        token = readFileSync(file, "utf8").trim();
    } catch { /* missing file — generate below */ }
    if (!/^[0-9a-f]{64}$/.test(token)) {
        token = "";
    }
    if (!token) {
        // Generate a 256-bit secret and persist it 0600 so a known
        // client stays known across launches. Fail closed if we cannot write.
        token = randomBytes(32).toString("hex");
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(file, token, { mode: 0o600 });
        } catch {
            const err = new Error("Cannot write the connection secret to ~/.cavalry-mcp — check the folder's permissions.");
            err.code = "FINGERPRINT_IO";
            throw err;
        }
    }
    fingerprintCache.set(slug, token);
    return token;
}

const SSE_URL = process.env.SSE_URL || "http://localhost:6768/sse";
const CONNECT_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_DEFAULT_MS = 60000;
// Give execute script a longer timeout of 5 minutes.
const CALL_TIMEOUT_SCRIPT_MS = 300000;

// Tools that mutate user state and must NEVER be auto-retried.
const NO_RETRY_TOOLS = new Set(["execute_script", "save_script_to_library", "cleanup_workspace"]);

function downstreamClientInfo() {
  const info = server.getClientVersion() ?? {};
  return { name: info.name || "", version: info.version || "" };
}

const TOOLS = [
  {
    name: "read_preamble",
    description: "Returns the Cavalry MCP preamble. execute_script refuses to run until this has been called in the session. The preamble explains how Cavalry's JavaScript API works and the difference between one-off scripts and reusable scripts that include UI.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      "title": "Read preamble",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
  },
  {
    name: "execute_script",
    description: "Execute JavaScript against the open Cavalry scene. Returns the captured console output and the last-evaluated expression. Refuses to run until read_preamble has been called in the session.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The JavaScript to execute" },
      },
      required: ["script"],
    },
    annotations: {
      "title": "Run script in Cavalry",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
  },
  {
    name: "preflight_script",
    description: "Compile a JavaScript snippet without running it, to check for syntax errors. Recommended before any non-trivial execute_script call.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The JavaScript to compile" },
      },
      required: ["script"],
    },
    annotations: {
      "title": "Preflight script",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
  },
  {
    name: "preflight_shader",
    description: "Compile-check a third-party SkSL shader/filter source WITHOUT installing or running it — the SkSL analogue of preflight_script. Returns OK or the compiler error. Cavalry compiles the raw source, so declare every uniform you use (resolution, your attributes, and any `uniform shader` inputs). The entry point must be `half4 main(float2 coord)`. Catches syntax/type errors, not runtime binding mismatches.",
    inputSchema: {
      type: "object",
      properties: {
        sksl: { type: "string", description: "The SkSL source to compile-check." },
      },
      required: ["sksl"],
    },
    annotations: {
      "title": "Preflight shader",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
  },
  {
    name: "cleanup_workspace",
    description: "Delete scratch files/directories your scripts created in their temp session directory. A path is removed only if it resolves inside a `cavalry-mcp-<...>` session folder under api.getTempFolder() — anything outside temp, or a temp path not in such a session folder, is rejected untouched, so you can never delete a user's project or another app's temp state. Non-existent paths are skipped (safe to re-run). Create scratch as `api.getTempFolder() + \"/cavalry-mcp-\" + Date.now()`, then call this with those paths once your multi-step task is done.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths to remove. Each must resolve inside a cavalry-mcp-<...> session folder under api.getTempFolder().",
        },
      },
      required: ["paths"],
    },
    annotations: {
      "title": "Clean up workspace",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
  },
  {
    name: "list_library_scripts",
    description: "List the names of the scripts in the Cavalry script library.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      "title": "List library scripts",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
  },
  {
    name: "read_library_script",
    description: "Read a script from the Cavalry script library.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title of the script to read." },
      },
      required: ["title"],
    },
    annotations: {
      "title": "Read library script",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
  },
  {
    name: "save_script_to_library",
    description: "Save a completed script to the Cavalry script library so it can be re-run later. Requires the user's confirmation for each script, recorded in the askedUser parameter.",
    inputSchema: {
      type: "object",
      properties: {
        askedUser: { type: "string", description: "Pass 'asked' to confirm you have asked the user for permission to save this script." },
        title: { type: "string", description: "The title of the script" },
        description: { type: "string", description: "A brief description of the script" },
        code: { type: "string", description: "The JavaScript itself" },
      },
      required: ["askedUser", "title", "description", "code"],
    },
    annotations: {
      "title": "Save script to library",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
  },
  {
    name: "search_api",
    description: "Search Cavalry's JavaScript API metadata. Returns ranked function/property hits with module + signature. Use get_api_function for full args/return details.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-form search (multi-word OK)." },
        limit: { type: "number", description: "Max results (default 15)." },
      },
      required: ["query"],
    },
    annotations: { "title": "Search API", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
  {
    name: "get_api_function",
    description: "Full definition of a JavaScript API function or property. Pass the bare name (eg. 'create'); pass module to disambiguate when the same name exists in multiple modules.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The function or property name." },
        module: { type: "string", description: "Module to disambiguate (cavalry/api/ui/ctx/def). Optional." },
      },
      required: ["name"],
    },
    annotations: { "title": "Get API function", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
  {
    name: "search_docs",
    description: "Full-text search over the bundled Cavalry documentation. Returns ranked hits with paths and snippets. Use read_doc with a returned path to fetch full content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-form search query." },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["query"],
    },
    annotations: { "title": "Search docs", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
  {
    name: "read_doc",
    description: "Read the full body of one Cavalry documentation page. Path is the slug returned by search_docs.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Doc path returned by search_docs." },
      },
      required: ["path"],
    },
    annotations: { "title": "Read doc", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
  {
    name: "search_layer_types",
    description: "Search Cavalry's available layer types by name, attribute names and tooltips. Use get_layer_definition for the full attribute list of one type.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-form search query." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
    annotations: { "title": "Search layer types", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
  {
    name: "get_layer_definition",
    description: "Get the full attribute list for a Cavalry layer type — id, type, default, min/max, tooltip, dropdown enum names. Does not need an instance.",
    inputSchema: {
      type: "object",
      properties: {
        nodeType: { type: "string", description: "The nodeType (eg. 'textShape')." },
      },
      required: ["nodeType"],
    },
    annotations: { "title": "Get layer definition", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
  {
    name: "search_examples",
    description: "Search Cavalry's bundled example presets — production-quality JavaScript scenes — by filename, folder, and first-comment summary.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-form search query." },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["query"],
    },
    annotations: { "title": "Search examples", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
  {
    name: "read_example",
    description: "Read the full source of a bundled example preset script. Path is what search_examples returns.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Preset path returned by search_examples." },
      },
      required: ["path"],
    },
    annotations: { "title": "Read example", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
  {
    name: "snapshot_layer",
    description: "USE THIS WHEN THE USER ASKS ABOUT APPEARANCE — eg. 'name the layers by what they look like', 'describe this scene', 'what shape is this?', 'tell me about each layer', 'is this a star or a cog?'. Renders to a PNG and returns it as an image content block. Two modes: (1) pass a layerId to render one drawable layer (and its descendants) framed tightly so even small on-stage shapes come out in full detail; iterate over a comp's children with api.getChildren() and call this once per child. (2) Omit layerId to render the whole active composition at its native aspect ratio — best for 'show me the scene' / 'what does the comp look like'. Optional maxSize (32–1024, default 256) clamps the longest edge; the layer mode returns a square thumbnail, the comp mode preserves aspect ratio. Optional frame renders at that frame instead of the current playhead (the timeline is restored afterwards) — use it to inspect a specific moment without a separate api.setFrame call. Non-drawable layers and layers with empty bounds return a clear error — skip those and continue.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "string", description: "Optional ID of the layer to snapshot (returned by api.create, etc.). Omit to snapshot the whole active composition." },
        maxSize: { type: "number", description: "Longest edge of the resulting thumbnail in pixels (32–1024). Default 256." },
        frame: { type: "number", description: "Optional frame to render at. Omit for the current playhead; the timeline is restored afterwards." },
      },
    },
    annotations: { "title": "Snapshot layer or comp", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false },
  },
];

let upstream = null;
let upstreamCaps = {};
// Single-flight guard: concurrent tool calls must share one connect attempt,
// otherwise the second freshConnect's destroyUpstream() kills the first's
// just-adopted connection mid-retry.
let connecting = null;
// A connect attempt parked on Cavalry's approval dialog. Reused rather than
// stacked: each parked attempt holds a blocked thread in Cavalry's bounded
// HTTP pool until the user answers.
let parked = null;

// Client.close()/transport.close() are async — a bare try/catch cannot catch
// their rejections, and one stray teardown rejection would kill the process.
function closeQuietly(closable) {
  try {
    const p = closable?.close();
    if (p && typeof p.catch === "function") {
      p.catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
}

process.on("unhandledRejection", (reason) => {
  console.error("cavalry-mcp bridge: unhandled rejection:", reason);
});

function raceWithTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const err = new Error(`Connection timed out after ${timeoutMs}ms`);
        err.code = "CONNECT_TIMEOUT";
        reject(err);
      }, timeoutMs)
    ),
  ]);
}

function destroyUpstream() {
  const old = upstream;
  upstream = null;
  upstreamCaps = {};
  closeQuietly(old);
}

// This tells the Client that we are waiting on a user response to allow connection.
async function freshConnect() {
  if (parked) {
    const err = new Error("Awaiting approval in Cavalry");
    err.code = "CONNECT_TIMEOUT";
    throw err;
  }
  destroyUpstream();
  const clientInfo = downstreamClientInfo();
  const headers = {
    "X-Cavalry-MCP-Fingerprint": fingerprintFor(clientInfo.name),
    "X-Cavalry-MCP-Client-Name": headerSafe(clientInfo.name),
    "X-Cavalry-MCP-Client-Version": headerSafe(clientInfo.version),
  };
  const transport = new SSEClientTransport(new URL(SSE_URL), {
    eventSourceInit: {
      fetch: (url, init) =>
        fetch(url, { ...init, headers: { ...(init?.headers || {}), ...headers } }),
    },
    requestInit: { headers },
  });
  const client = new Client(
    { name: clientInfo.name || "Cavalry MCP Bridge", version: clientInfo.version || "0.0.0" },
    { capabilities: {} }
  );
  // Tear the client down on transport error/close.
  let dropped = false;
  const dropIfCurrent = () => {
    dropped = true;
    if (upstream === client) {
      destroyUpstream();
    }
  };
  transport.onerror = dropIfCurrent;
  transport.onclose = dropIfCurrent;

  const adopt = () => {
    if (dropped) {
      closeQuietly(client);
      return;
    }
    if (upstream) {
      closeQuietly(client);
      return;
    }
    upstream = client;
    upstreamCaps = client.getServerCapabilities() ?? {};
// Nudge the client to re-fetch the up-to-date tool list. Currently, it only
// has the static list.
    try {
      server.sendToolListChanged().catch(() => { /* host may ignore it */ });
    } catch { /* not connected yet — first list will still hit the live path */ }
  };

  const pending = client.connect(transport);
  try {
    await raceWithTimeout(pending, CONNECT_TIMEOUT_MS);
  } catch (err) {
    if (err?.code === "CONNECT_TIMEOUT") {
      // Notify the client that the dialog is shown and the connection needs to be allowed.
      parked = pending;
      pending
        .then(adopt, () => closeQuietly(transport))
        .catch(() => { /* adopt must never surface as an unhandled rejection */ })
        .finally(() => {
          if (parked === pending) {
            parked = null;
          }
        });
    } else {
      closeQuietly(transport);
    }
    throw err;
  }
  adopt();
}

async function ensureUpstream() {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (upstream) {
      return upstream;
    }
    if (!connecting) {
      connecting = freshConnect().finally(() => { connecting = null; });
    }
    await connecting;
    if (upstream) {
      return upstream;
    }
  }
  const err = new Error("Connection to Cavalry is unstable — try again.");
  err.code = "CONN_UNSTABLE";
  throw err;
}

async function withUpstream(fn, retryable) {
  let client = await ensureUpstream();
  try {
    return await fn(client);
  } catch (err) {
    // Retry ONLY when this call's connection actually died.
    if (upstream === client) {
      throw err;
    }
    if (!retryable) {
      // Be verbose about a dropped connection mid-call.
      const lost = new Error(
        "Connection to Cavalry was lost mid-call, and the call may still have completed. " +
        "Verify the scene/library state before re-running anything destructive."
      );
      lost.code = "CONN_LOST_MID_CALL";
      throw lost;
    }
    client = await ensureUpstream();
    return await fn(client);
  }
}

function mcpError(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

function notApprovedError() {
  return mcpError(
    `ERROR: Cavalry has not approved this connection.\n\n` +
    `Switch to Cavalry and click Allow on the approval dialog, then try again.`
  );
}

function offlineError() {
  return mcpError(
    `ERROR: Cavalry is not running, or the MCP server is not enabled in Preferences.\n\n` +
    `Please start Cavalry, enable the MCP server in Preferences, then try again.`
  );
}

const server = new Server(
  { name: "Cavalry MCP", version: "1.0.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: {},
      prompts: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Prefer Cavalry's own authoritative tool list when a connection already
  // exists, so the tools/descriptions have a single source of truth (the
  // in-app registerTools()) rather than drifting from the static array below.
  // Deliberately do NOT force a fresh connection just to list — that would
  // trigger the approval prompt before the user has asked for anything, and
  // listing must still work when Cavalry is offline. The static TOOLS array is
  // the offline fallback (and what's shown at first launch, before any call).
  if (upstream) {
    try {
      const live = await upstream.listTools();
      if (live && Array.isArray(live.tools) && live.tools.length > 0) {
        return { tools: live.tools };
      }
    } catch {
      // Connection died mid-session — fall back to the static list.
    }
  }
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const toolName = request.params?.name;
    return await withUpstream(
      (client) => client.callTool(request.params, CallToolResultSchema, {
        timeout: toolName === "execute_script" ? CALL_TIMEOUT_SCRIPT_MS : CALL_TIMEOUT_DEFAULT_MS,
      }),
      !NO_RETRY_TOOLS.has(toolName)
    );
  } catch (err) {
    // A JSON-RPC error from Cavalry (unknown tool, bad params, session not
    // initialised).
    if (err instanceof McpError) {
      return mcpError(`ERROR: ${err.message}`);
    }
    // Key off the actual HTTP status, not a substring of an arbitrary message.
    // SSEClientTransport GET failures surface as SseError with a numeric .code;
    // POST failures throw a plain Error whose message is exactly:
    //   "Error POSTing to endpoint (HTTP <status>): <body>"
    // — that wording is SDK source (client/sse.js line 192).
    const postStatusMatch = err?.message?.match(/Error POSTing to endpoint \(HTTP (\d+)\)/);
    const status = err?.code ?? (postStatusMatch ? Number(postStatusMatch[1]) : null);
    if (status === 401 || status === 403 || status === "CONNECT_TIMEOUT") {
      return notApprovedError();
    }
    if (status === "FINGERPRINT_IO" || status === "CONN_LOST_MID_CALL" || status === "CONN_UNSTABLE") {
      return mcpError(`ERROR: ${err.message}`);
    }
    return offlineError();
  }
});

// Resources/prompts handlers are PASSIVE: they answer from an existing
// upstream connection but never create one. Hosts call these at every launch,
// and connecting here would pop Cavalry's approval dialog before the user
// asked for anything (and stall startup by the connect timeout when Cavalry
// is closed) — the same rule as the tools/list handler above. Cavalry
// currently exposes neither, so these exist only to forward a future Cavalry
// that does.

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  if (!upstream || !upstreamCaps.resources) {
    return { resources: [] };
  }
  try {
    return await upstream.listResources(request.params);
  } catch {
    return { resources: [] };
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (!upstream || !upstreamCaps.resources) {
    // Thrown McpErrors become proper JSON-RPC errors; a tool-result shape
    // here would fail the host's resources/read schema validation.
    throw new McpError(ErrorCode.InvalidRequest, "Cavalry exposes no resources on this connection.");
  }
  return upstream.readResource(request.params);
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
  if (!upstream || !upstreamCaps.resources) {
    return { resourceTemplates: [] };
  }
  try {
    return await upstream.listResourceTemplates(request.params);
  } catch {
    return { resourceTemplates: [] };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
  if (!upstream || !upstreamCaps.prompts) {
    return { prompts: [] };
  }
  try {
    return await upstream.listPrompts(request.params);
  } catch {
    return { prompts: [] };
  }
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (!upstream || !upstreamCaps.prompts) {
    throw new McpError(ErrorCode.InvalidRequest, "Cavalry exposes no prompts on this connection.");
  }
  return upstream.getPrompt(request.params);
});

// Reap upstream pre-close.
server.onclose = () => {
  destroyUpstream();
  process.exit(0);
};

const stdioTransport = new StdioServerTransport();
server.connect(stdioTransport).catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGINT", () => {
  // Gracefully close on SIGINT.
  closeQuietly(server);
  setTimeout(() => process.exit(0), 500).unref();
});
