const express = require("express");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = process.env.PORT || 3456;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Track active Claude sessions
const sessions = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function spawnClaude(prompt, cwd) {
  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    "-p",
    prompt,
  ];

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let buffer = "";

  sessions.set(sessionId, { proc, startedAt: Date.now(), prompt });

  broadcast({
    type: "session_start",
    sessionId,
    prompt,
    timestamp: Date.now(),
  });

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete trailing line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        broadcast({ type: "claude_event", sessionId, event, timestamp: Date.now() });
      } catch {
        broadcast({ type: "raw_output", sessionId, text: line, timestamp: Date.now() });
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    broadcast({ type: "stderr", sessionId, text: chunk.toString(), timestamp: Date.now() });
  });

  proc.on("close", (code) => {
    sessions.delete(sessionId);
    broadcast({ type: "session_end", sessionId, exitCode: code, timestamp: Date.now() });
  });

  return sessionId;
}

// REST API
app.post("/api/session", (req, res) => {
  const { prompt, cwd } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });
  const sessionId = spawnClaude(prompt, cwd);
  res.json({ sessionId });
});

app.get("/api/sessions", (_req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, prompt: s.prompt, startedAt: s.startedAt });
  }
  res.json(list);
});

app.delete("/api/session/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  s.proc.kill("SIGTERM");
  res.json({ ok: true });
});

// Demo mode: replay a fake session for testing without a real Claude binary
app.post("/api/demo", (_req, res) => {
  const sessionId = "demo-" + Date.now().toString(36);
  broadcast({ type: "session_start", sessionId, prompt: "Demo session", timestamp: Date.now() });

  const events = [
    { type: "system", subtype: "init", tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task"], model: "claude-sonnet-4-20250514", cwd: "/home/user/project" },
    { type: "assistant", message: { content: [{ type: "text", text: "Let me explore the codebase first." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Glob", input: { pattern: "src/**/*.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "src/index.ts\nsrc/utils.ts\nsrc/config.ts" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/home/user/project/src/index.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "import { Config } from './config';\n\nexport function main() {\n  console.log('hello');\n}" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Now I'll update the file." }, { type: "tool_use", id: "tu_3", name: "Edit", input: { file_path: "/home/user/project/src/index.ts", old_string: "console.log('hello');", new_string: "console.log('hello world');" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_3", content: "File edited successfully." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_4", name: "Bash", input: { command: "npm test", description: "Run tests" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_4", content: "PASS src/index.test.ts\n  main\n    ✓ prints hello world (3ms)\n\nTests: 1 passed, 1 total" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_5", name: "Task", input: { prompt: "Search for all error handling patterns", subagent_type: "Explore", description: "Find error handlers" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_5", content: "Found 3 try/catch blocks in src/utils.ts, 1 in src/config.ts" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "All done. I updated the greeting message and verified tests pass." }] } },
    { type: "result", subtype: "success", is_error: false, num_turns: 6, total_cost_usd: 0.042, result: "Updated greeting and verified tests." },
  ];

  let i = 0;
  const interval = setInterval(() => {
    if (i >= events.length) {
      clearInterval(interval);
      broadcast({ type: "session_end", sessionId, exitCode: 0, timestamp: Date.now() });
      return;
    }
    broadcast({ type: "claude_event", sessionId, event: events[i], timestamp: Date.now() });
    i++;
  }, 800);

  res.json({ sessionId });
});

server.listen(PORT, () => {
  console.log(`Claude Code Monitor running at http://localhost:${PORT}`);
});
