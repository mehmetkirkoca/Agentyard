import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface GeminiCommandOptions {
  sessionUuid?: string;
  isNew?: boolean;
  targetDir?: string;
  skipPermissions?: boolean;
  model?: string;
}

export function geminiSessionExists(targetDir: string, sessionUuid: string, home: string = os.homedir()): boolean {
  const chatsDir = findGeminiChatDir(targetDir, home);
  if (!chatsDir || !fs.existsSync(chatsDir)) return false;
  try {
    const shortId = sessionUuid.slice(0, 8);
    const files = fs.readdirSync(chatsDir);
    return files.some(f => f.includes(shortId));
  } catch {
    return false;
  }
}

export function buildGeminiCommand(opts: GeminiCommandOptions = {}): string {
  const parts = ["gemini"];
  if (opts.sessionUuid) {
    const exists = opts.targetDir ? geminiSessionExists(opts.targetDir, opts.sessionUuid) : false;
    if (opts.isNew || !exists) {
      parts.push(`--session-id ${opts.sessionUuid}`);
    } else {
      parts.push(`--resume ${opts.sessionUuid}`);
    }
  }
  if (opts.skipPermissions) {
    parts.push("-y");
  }
  if (opts.model) {
    parts.push(`-m ${opts.model}`);
  }
  return parts.join(" ");
}

export function findGeminiChatDir(targetDir: string, home: string = os.homedir()): string | undefined {
  const tmpDir = path.join(home, ".gemini", "tmp");
  if (!fs.existsSync(tmpDir)) return undefined;
  try {
    const entries = fs.readdirSync(tmpDir, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rootFile = path.join(tmpDir, entry.name, ".project_root");
      if (fs.existsSync(rootFile)) {
        try {
          const rootPath = fs.readFileSync(rootFile, "utf8").trim();
          if (path.resolve(rootPath) === path.resolve(targetDir)) {
            const chatsDir = path.join(tmpDir, entry.name, "chats");
            if (fs.existsSync(chatsDir)) return chatsDir;
          }
        } catch {}
      }
    }
  } catch {}
  return undefined;
}

export function readGeminiPromptsAndModel(targetDir: string, home: string = os.homedir(), sessionUuid?: string): {prompts: string[]; model?: string} {
  const chatsDir = findGeminiChatDir(targetDir, home);
  if (!chatsDir) return {prompts: []};
  try {
    const files = fs.readdirSync(chatsDir)
      .filter(f => f.endsWith(".jsonl") || f.endsWith(".json"))
      .map(f => path.join(chatsDir, f));
    if (files.length === 0) return {prompts: []};
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    let latestFile = files[0];
    if (sessionUuid) {
      const shortId = sessionUuid.slice(0, 8);
      const matched = files.find(f => path.basename(f).includes(shortId));
      if (matched) latestFile = matched;
    }
    const raw = fs.readFileSync(latestFile, "utf8");
    const prompts: string[] = [];
    let latestModel: string | undefined;

    if (latestFile.endsWith(".jsonl")) {
      const lines = raw.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.model && typeof obj.model === "string") {
            latestModel = obj.model;
          }
          if (obj.type === "user") {
            let text = "";
            if (typeof obj.content === "string") text = obj.content;
            else if (Array.isArray(obj.content)) {
              text = obj.content.map((c: any) => c.text || "").join(" ");
            }
            const trimmed = text.trim();
            if (trimmed && !trimmed.startsWith("<session_context>") && !trimmed.startsWith("<context>")) {
              prompts.push(trimmed);
            }
          } else if (obj.type === "gemini" && obj.model) {
            latestModel = obj.model;
          }
        } catch {}
      }
    } else {
      const content = JSON.parse(raw);
      if (Array.isArray(content.messages)) {
        for (const msg of content.messages) {
          if (msg.type === "user") {
            let text = "";
            if (typeof msg.content === "string") text = msg.content;
            else if (Array.isArray(msg.content)) {
              text = msg.content.map((c: any) => c.text || "").join(" ");
            }
            const trimmed = text.trim();
            if (trimmed && !trimmed.startsWith("<session_context>") && !trimmed.startsWith("<context>")) {
              prompts.push(trimmed);
            }
          } else if (msg.type === "gemini" && msg.model) {
            latestModel = msg.model;
          }
        }
      }
      if (content.model && typeof content.model === "string") {
        latestModel = content.model;
      }
    }
    return {prompts, model: latestModel};
  } catch {
    return {prompts: []};
  }
}
