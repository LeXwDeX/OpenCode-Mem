import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WORKER_PORT = 37777;
const messageTextCache = new Map();
const pendingUserMessages = new Map();
const messageRoleCache = new Map();
const sessionLastAssistant = new Map();
const sessionLastSummarized = new Map();
const toolInputCache = new Map();

const PLUGIN_ROOT = resolvePluginRoot();

function truncate(text, maxLength = 8000) {
  if (typeof text !== "string") return text;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function resolvePluginRoot() {
  const fileDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [];

  if (process.env.CLAUDE_MEM_ROOT) {
    candidates.push(process.env.CLAUDE_MEM_ROOT);
  }

  candidates.push(fileDir);
  candidates.push(path.resolve(fileDir, ".."));
  candidates.push(path.join(fileDir, "claude-mem"));

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "plugin", "scripts", "worker-service.cjs"))) {
      return candidate;
    }
  }

  return path.resolve(fileDir, "..");
}

function parseToolInput(metadata) {
  if (!metadata) return {};
  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata);
    } catch {
      return { raw: truncate(metadata) };
    }
  }
  return metadata;
}

function normalizeToolName(name) {
  if (!name || typeof name !== "string") return "Unknown";
  if (name === "Bash") return name;
  if (name === "Glob") return name;
  if (name === "Grep") return name;
  if (name === "Read") return name;
  if (name === "Edit") return name;
  if (name === "Write") return name;
  if (name === "Task") return name;
  if (name === "Skill") return name;
  return name;
}

function getProjectName(cwd) {
  if (!cwd || typeof cwd !== "string") return "unknown-project";
  const base = path.basename(cwd);
  if (base) return base;
  return "unknown-project";
}

function getProjectsParam(cwd) {
  return getProjectName(cwd);
}

function serializeToolOutput(output) {
  if (output == null) return "";
  if (typeof output === "string") return truncate(output, 16000);
  try {
    return JSON.stringify(output);
  } catch {
    return truncate(String(output), 16000);
  }
}

async function startWorker(ctx) {
  const runner = path.join(PLUGIN_ROOT, "plugin", "scripts", "bun-runner.js");
  const worker = path.join(PLUGIN_ROOT, "plugin", "scripts", "worker-service.cjs");
  const command = `node "${runner}" "${worker}" start`;
  await ctx.$`${{ raw: command }}`.nothrow().quiet();
}

async function ensureInstalled(ctx) {
  const installer = path.join(PLUGIN_ROOT, "plugin", "scripts", "smart-install.js");
  const command = `node "${installer}"`;
  await ctx.$`${{ raw: command }}`
    .env({
      CLAUDE_MEM_ROOT: PLUGIN_ROOT
    })
    .nothrow()
    .quiet();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.text();
}

async function fetchJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function sendSessionInit(contentSessionId, project, prompt) {
  const body = {
    contentSessionId,
    project,
    prompt
  };
  await fetchJson(`http://127.0.0.1:${WORKER_PORT}/api/sessions/init`, body);
}

async function sendSessionSummarize(contentSessionId, lastAssistantMessage) {
  const body = {
    contentSessionId,
    last_assistant_message: lastAssistantMessage
  };
  await fetchJson(`http://127.0.0.1:${WORKER_PORT}/api/sessions/summarize`, body);
}

async function sendSessionComplete(contentSessionId) {
  const body = { contentSessionId };
  await fetchJson(`http://127.0.0.1:${WORKER_PORT}/api/sessions/complete`, body);
}

function updateMessageText(part, delta) {
  if (!part || part.type !== "text") return;
  const messageId = part.messageID;
  if (!messageId) return;

  const existing = messageTextCache.get(messageId) || "";
  let nextText = existing;

  if (typeof delta === "string" && delta.length > 0) {
    nextText = existing + delta;
  } else if (typeof part.text === "string" && part.text.length > 0) {
    nextText = part.text;
  }

  messageTextCache.set(messageId, nextText);
}

export const ClaudeMemPlugin = async (ctx) => {
  await ensureInstalled(ctx);
  await startWorker(ctx);

  return {
    event: async ({ event }) => {
      const cwd = ctx.directory || process.cwd();

      if (event.type === "tui.prompt.append") {
        const projects = getProjectsParam(cwd);
        const url = `http://127.0.0.1:${WORKER_PORT}/api/context/inject?projects=${encodeURIComponent(projects)}`;
        try {
          const context = (await fetchText(url)).trim();
          if (context) {
            event.properties.text = `${context}\n\n${event.properties.text}`;
          }
        } catch {
          // Fail open: do not block prompt if worker unavailable
        }
      }

      if (event.type === "message.updated") {
        const info = event.properties?.info;
        if (info?.id && info?.role) {
          messageRoleCache.set(info.id, info.role);
        }

        if (info && info.role === "user") {
          const cachedText = messageTextCache.get(info.id);
          const summaryText = info.summary?.body || info.summary?.title;
          const project = getProjectName(cwd);

          if (cachedText && cachedText.trim()) {
            try {
              await sendSessionInit(info.sessionID, project, cachedText);
              messageTextCache.delete(info.id);
            } catch {
              // Fail open
            }
            return;
          }

          if (summaryText && summaryText.trim() && summaryText !== "[user message]") {
            try {
              await sendSessionInit(info.sessionID, project, summaryText);
            } catch {
              // Fail open
            }
            return;
          }

          pendingUserMessages.set(info.id, {
            sessionID: info.sessionID,
            project
          });
        }
      }

      if (event.type === "message.part.updated") {
        const part = event.properties?.part;
        const delta = event.properties?.delta;
        updateMessageText(part, delta);

        const pending = pendingUserMessages.get(part?.messageID);
        const text = messageTextCache.get(part?.messageID);
        const role = messageRoleCache.get(part?.messageID);
        const sessionId = part?.sessionID;

        if (pending && text && text.trim()) {
          try {
            await sendSessionInit(pending.sessionID, pending.project, text);
          } catch {
            // Fail open
          } finally {
            pendingUserMessages.delete(part.messageID);
            messageTextCache.delete(part.messageID);
          }
        }

        if (role === "assistant" && sessionId && text) {
          sessionLastAssistant.set(sessionId, text);
        }
      }

      if (event.type === "message.removed") {
        const messageId = event.properties?.messageID;
        if (messageId) {
          messageTextCache.delete(messageId);
          messageRoleCache.delete(messageId);
          pendingUserMessages.delete(messageId);
        }
      }

      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID;
        if (!sessionId) return;

        const lastAssistant = sessionLastAssistant.get(sessionId);
        const lastSummarized = sessionLastSummarized.get(sessionId);

        if (lastAssistant && lastAssistant.trim() && lastAssistant !== lastSummarized) {
          try {
            await sendSessionSummarize(sessionId, lastAssistant);
            sessionLastSummarized.set(sessionId, lastAssistant);
          } catch {
            // Fail open
          }
        }

        try {
          await sendSessionComplete(sessionId);
        } catch {
          // Fail open
        }
      }

      if (event.type === "session.deleted") {
        const sessionId = event.properties?.sessionID;
        if (!sessionId) return;
        try {
          await sendSessionComplete(sessionId);
        } catch {
          // Fail open
        }
      }
    },
    "tool.execute.before": async (input, output) => {
      toolInputCache.set(input.callID, output?.args ?? {});
    },
    "tool.execute.after": async (input, output) => {
      const toolName = normalizeToolName(input.tool);
      const cachedArgs = toolInputCache.get(input.callID);
      toolInputCache.delete(input.callID);
      const toolInput = parseToolInput(cachedArgs ?? output?.metadata ?? {});
      const toolResponse = {
        title: output?.title || toolName,
        output: serializeToolOutput(output?.output || ""),
        metadata: output?.metadata ?? {}
      };
      const body = {
        contentSessionId: input.sessionID,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        cwd: ctx.directory || process.cwd()
      };
      try {
        await fetchJson(`http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`, body);
      } catch {
        // Fail open
      }
    }
  };
};

export default ClaudeMemPlugin;
