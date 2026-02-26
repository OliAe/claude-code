const express = require("express");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

const PORT = process.env.PORT || 3456;
const AGENT_BIN = process.env.AGENT_BIN || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || path.join(process.cwd(), "workspace");

// Ensure workspace exists
if (!fs.existsSync(PROJECT_DIR)) fs.mkdirSync(PROJECT_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ─── Session management ───
const sessions = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ─── Agent subprocess + translation layer ───

function spawnAgent(prompt, cwd) {
  const workDir = cwd || PROJECT_DIR;
  const args = ["--output-format", "stream-json", "--verbose", "-p", prompt];
  const proc = spawn(AGENT_BIN, args, {
    cwd: workDir,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let buffer = "";
  const fileChanges = new Map(); // track files modified in this session

  const session = { proc, startedAt: Date.now(), prompt, cwd: workDir, fileChanges };
  sessions.set(sessionId, session);

  broadcast({ type: "session_start", sessionId, prompt, cwd: workDir, timestamp: Date.now() });

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        // Broadcast raw event
        broadcast({ type: "agent_event", sessionId, event, timestamp: Date.now() });
        // Translate to frontend-friendly events
        translateEvent(sessionId, event, workDir, fileChanges);
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

// ─── Translation layer: agent events → frontend events ───

function translateEvent(sessionId, event, workDir, fileChanges) {
  // System init
  if (event.type === "system" && event.subtype === "init") {
    broadcast({
      type: "fe_init",
      sessionId,
      model: event.model,
      tools: event.tools,
      cwd: event.cwd || workDir,
      timestamp: Date.now(),
    });
    return;
  }

  // Result
  if (event.type === "result") {
    broadcast({
      type: "fe_result",
      sessionId,
      success: !event.is_error,
      result: event.result,
      numTurns: event.num_turns,
      costUsd: event.total_cost_usd,
      timestamp: Date.now(),
    });
    return;
  }

  // Assistant messages → extract text and tool calls
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        broadcast({
          type: "fe_assistant_text",
          sessionId,
          text: block.text,
          timestamp: Date.now(),
        });
      } else if (block.type === "tool_use") {
        const translated = translateToolUse(block, workDir, fileChanges);
        broadcast({
          type: "fe_tool_call",
          sessionId,
          toolCallId: block.id,
          ...translated,
          timestamp: Date.now(),
        });
      }
    }
    return;
  }

  // User messages → tool results
  if (event.type === "user" && event.message?.content) {
    const content = event.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "tool_result") {
        const text = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content, null, 2);
        broadcast({
          type: "fe_tool_result",
          sessionId,
          toolCallId: block.tool_use_id,
          output: text,
          timestamp: Date.now(),
        });
        // If a file was written/edited, notify frontend to refresh
        const change = fileChanges.get(block.tool_use_id);
        if (change) {
          broadcast({
            type: "fe_file_changed",
            sessionId,
            filePath: change.filePath,
            action: change.action,
            timestamp: Date.now(),
          });
        }
      }
    }
  }
}

function translateToolUse(block, workDir, fileChanges) {
  const { name, input, id } = block;
  switch (name) {
    case "Write":
      fileChanges.set(id, { filePath: input.file_path, action: "write" });
      return {
        tool: "write",
        filePath: input.file_path,
        content: input.content,
        description: `Create ${relativePath(input.file_path, workDir)}`,
      };
    case "Edit":
      fileChanges.set(id, { filePath: input.file_path, action: "edit" });
      return {
        tool: "edit",
        filePath: input.file_path,
        oldString: input.old_string,
        newString: input.new_string,
        description: `Edit ${relativePath(input.file_path, workDir)}`,
      };
    case "Read":
      return {
        tool: "read",
        filePath: input.file_path,
        description: `Read ${relativePath(input.file_path, workDir)}`,
      };
    case "Bash":
      return {
        tool: "bash",
        command: input.command,
        description: input.description || input.command,
      };
    case "Glob":
      return {
        tool: "glob",
        pattern: input.pattern,
        description: `Search for ${input.pattern}`,
      };
    case "Grep":
      return {
        tool: "grep",
        pattern: input.pattern,
        path: input.path,
        description: `Grep /${input.pattern}/`,
      };
    case "Task":
      return {
        tool: "task",
        subagentType: input.subagent_type,
        taskDescription: input.description,
        prompt: input.prompt,
        description: `[${input.subagent_type}] ${input.description || ""}`,
      };
    default:
      return {
        tool: name.toLowerCase(),
        input,
        description: `${name} call`,
      };
  }
}

function relativePath(filePath, workDir) {
  if (!filePath || !workDir) return filePath || "";
  return filePath.startsWith(workDir) ? filePath.slice(workDir.length + 1) : filePath;
}

// ─── File system API ───

app.get("/api/files", (req, res) => {
  const dir = req.query.path || PROJECT_DIR;
  try {
    const tree = buildFileTree(dir, dir);
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildFileTree(dirPath, rootDir) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result = [];
  const sortedEntries = entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
  for (const entry of sortedEntries) {
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(rootDir, fullPath);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: relPath,
        type: "folder",
        children: buildFileTree(fullPath, rootDir),
      });
    } else {
      const stat = fs.statSync(fullPath);
      result.push({
        name: entry.name,
        path: relPath,
        type: "file",
        size: stat.size,
      });
    }
  }
  return result;
}

app.get("/api/file", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: "path required" });
  const fullPath = filePath.startsWith("/") ? filePath : path.join(PROJECT_DIR, filePath);
  try {
    const content = fs.readFileSync(fullPath, "utf-8");
    res.json({ path: filePath, content });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.put("/api/file", (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: "path required" });
  const fullPath = filePath.startsWith("/") ? filePath : path.join(PROJECT_DIR, filePath);
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
    broadcast({ type: "fe_file_changed", filePath: fullPath, action: "write", timestamp: Date.now() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/file", (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: "path required" });
  const fullPath = filePath.startsWith("/") ? filePath : path.join(PROJECT_DIR, filePath);
  try {
    fs.unlinkSync(fullPath);
    broadcast({ type: "fe_file_changed", filePath: fullPath, action: "delete", timestamp: Date.now() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Session API ───

app.post("/api/session", (req, res) => {
  const { prompt, cwd } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });
  const sessionId = spawnAgent(prompt, cwd);
  res.json({ sessionId });
});

app.get("/api/sessions", (_req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, prompt: s.prompt, startedAt: s.startedAt, cwd: s.cwd });
  }
  res.json(list);
});

app.delete("/api/session/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  s.proc.kill("SIGTERM");
  res.json({ ok: true });
});

// ─── Project info ───

app.get("/api/project", (_req, res) => {
  res.json({ projectDir: PROJECT_DIR });
});

// ─── Demo mode ───

app.post("/api/demo", (_req, res) => {
  const sessionId = "demo-" + Date.now().toString(36);
  const workDir = PROJECT_DIR;

  broadcast({ type: "session_start", sessionId, prompt: "Build a React counter app", cwd: workDir, timestamp: Date.now() });

  const events = [
    { type: "system", subtype: "init", tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task"], model: "sonnet-4-20250514", cwd: workDir },
    { type: "assistant", message: { content: [{ type: "text", text: "I'll create a React counter application for you. Let me set up the project files." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Write", input: { file_path: workDir + "/package.json", content: '{\n  "name": "counter-app",\n  "version": "1.0.0",\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build"\n  },\n  "dependencies": {\n    "react": "^18.2.0",\n    "react-dom": "^18.2.0"\n  },\n  "devDependencies": {\n    "vite": "^5.0.0",\n    "@vitejs/plugin-react": "^4.2.0"\n  }\n}' } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "File written successfully." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_2", name: "Write", input: { file_path: workDir + "/index.html", content: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Counter App</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>' } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "File written successfully." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_3", name: "Write", input: { file_path: workDir + "/src/main.jsx", content: "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nimport './styles.css';\n\nReactDOM.createRoot(document.getElementById('root')).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_3", content: "File written successfully." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_4", name: "Write", input: { file_path: workDir + "/src/App.jsx", content: "import { useState } from 'react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <div className=\"app\">\n      <h1>Counter</h1>\n      <div className=\"counter\">\n        <button onClick={() => setCount(c => c - 1)}>-</button>\n        <span className=\"count\">{count}</span>\n        <button onClick={() => setCount(c => c + 1)}>+</button>\n      </div>\n      <button className=\"reset\" onClick={() => setCount(0)}>\n        Reset\n      </button>\n    </div>\n  );\n}" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_4", content: "File written successfully." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_5", name: "Write", input: { file_path: workDir + "/src/styles.css", content: "* { margin: 0; padding: 0; box-sizing: border-box; }\nbody { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }\n.app { text-align: center; }\nh1 { font-size: 2rem; margin-bottom: 2rem; background: linear-gradient(135deg, #a78bfa, #60a5fa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }\n.counter { display: flex; align-items: center; gap: 1.5rem; margin-bottom: 1.5rem; }\n.counter button { width: 48px; height: 48px; border-radius: 12px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; font-size: 1.25rem; cursor: pointer; transition: all 0.15s; }\n.counter button:hover { border-color: #a78bfa; background: #7c3aed22; }\n.count { font-size: 3rem; font-weight: 700; min-width: 80px; }\n.reset { padding: 8px 24px; border-radius: 8px; border: 1px solid #334155; background: transparent; color: #94a3b8; cursor: pointer; transition: all 0.15s; }\n.reset:hover { border-color: #f87171; color: #f87171; }" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_5", content: "File written successfully." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_6", name: "Bash", input: { command: "cd " + workDir + " && npm install", description: "Install dependencies" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_6", content: "added 72 packages in 3s\n\n12 packages are looking for funding\n  run `npm fund` for details" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_7", name: "Bash", input: { command: "cd " + workDir + " && npm run dev", description: "Start dev server" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_7", content: "  VITE v5.0.0  ready in 234ms\n\n  ➜  Local:   http://localhost:5173/" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "The React counter app is running at http://localhost:5173/. It has:\n\n- Increment (+) and decrement (-) buttons\n- A large count display\n- A reset button\n- Dark theme with gradient heading and hover effects" }] } },
    { type: "result", subtype: "success", is_error: false, num_turns: 8, total_cost_usd: 0.038, result: "Created React counter app with Vite." },
  ];

  let i = 0;
  const interval = setInterval(() => {
    if (i >= events.length) {
      clearInterval(interval);
      broadcast({ type: "session_end", sessionId, exitCode: 0, timestamp: Date.now() });
      return;
    }
    const event = events[i];
    broadcast({ type: "agent_event", sessionId, event, timestamp: Date.now() });
    translateEvent(sessionId, event, workDir, new Map());
    i++;
  }, 900);

  res.json({ sessionId });
});

server.listen(PORT, () => {
  console.log(`Code Studio running at http://localhost:${PORT}`);
  console.log(`Project directory: ${PROJECT_DIR}`);
});
