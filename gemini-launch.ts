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

/** Gemini CLI names a chat file session-<timestamp>[-<n>]-<first 8 chars of the session id>.json(l). */
function isChatFileOf(fileName: string, sessionUuid: string): boolean {
  const shortId = sessionUuid.slice(0, 8);
  return fileName.endsWith(`-${shortId}.jsonl`) || fileName.endsWith(`-${shortId}.json`);
}

export function geminiSessionExists(targetDir: string, sessionUuid: string, home: string = os.homedir()): boolean {
  const chatsDir = findGeminiChatDir(targetDir, home);
  if (!chatsDir) return false;
  try {
    return fs.readdirSync(chatsDir).some(f => isChatFileOf(f, sessionUuid));
  } catch (error) {
    console.error(`Error listing Gemini chats in ${chatsDir}:`, error);
    return false;
  }
}

export function buildGeminiCommand(opts: GeminiCommandOptions = {}): string {
  const parts = ["gemini"];
  if (opts.sessionUuid) {
    // Gemini writes the chat file at startup, so an existing file means the session can be resumed
    const exists = opts.targetDir ? geminiSessionExists(opts.targetDir, opts.sessionUuid) : false;
    parts.push(opts.isNew || !exists ? `--session-id ${opts.sessionUuid}` : `--resume ${opts.sessionUuid}`);
  }
  // -y/--yolo is deprecated in favour of --approval-mode
  if (opts.skipPermissions) parts.push("--approval-mode=yolo");
  if (opts.model) parts.push(`-m ${opts.model}`);
  return parts.join(" ");
}

/** Folder of the Gemini CLI extension through which Agentyard receives hook events. */
export const GEMINI_STATUS_EXTENSION_NAME = "agentyard-status";

export function geminiStatusExtensionDir(home: string = os.homedir()): string {
  return path.join(home, ".gemini", "extensions", GEMINI_STATUS_EXTENSION_NAME);
}

/**
 * Hook command: when Agentyard prepared <statusDir>/<session id>.jsonl for this session, append one
 * JSON line holding only the fields the status logic reads (event name, session id, notification
 * type). Any other Gemini session (one Agentyard did not start) has no such file: the input is
 * drained and nothing is written. Gemini substitutes $GEMINI_SESSION_ID with a shell-quoted value,
 * so it stands outside the quotes.
 */
export function buildGeminiHookCommand(statusDir: string): string {
  const fields = `grep -oE '"(hook_event_name|session_id|notification_type)" *: *"[^"]*"' | paste -sd, -`;
  return `f='${statusDir}'/$GEMINI_SESSION_ID.jsonl; `
    + `if [ -f "$f" ]; then printf '{%s}\\n' "$(${fields})" >> "$f"; else cat > /dev/null; fi`;
}

/**
 * The extension's files. Gemini CLI reads hooks only from settings files and extensions, and an
 * alternative system settings file must be owned by root, so an extension is the one place
 * Agentyard can add hooks without editing the user's ~/.gemini/settings.json.
 */
export function buildGeminiStatusExtension(statusDir: string): {manifest: object; hooks: object} {
  const hooks = [{type: "command", command: buildGeminiHookCommand(statusDir)}];
  return {
    manifest: {
      name: GEMINI_STATUS_EXTENSION_NAME,
      version: "1.0.0",
      description: "Reports session status to Agentyard; does nothing in sessions Agentyard did not start",
    },
    hooks: {
      hooks: {
        BeforeAgent: [{hooks}],
        AfterTool: [{matcher: "*", hooks}],
        Notification: [{hooks}],
        AfterAgent: [{hooks}],
      },
    },
  };
}

/** Write the extension, only touching files whose content changed. Returns an error message or null. */
export function ensureGeminiStatusExtension(statusDir: string, home: string = os.homedir()): string | null {
  const dir = geminiStatusExtensionDir(home);
  const {manifest, hooks} = buildGeminiStatusExtension(statusDir);
  const files: [string, string][] = [
    [path.join(dir, "gemini-extension.json"), JSON.stringify(manifest, null, 2) + "\n"],
    [path.join(dir, "hooks", "hooks.json"), JSON.stringify(hooks, null, 2) + "\n"],
  ];
  try {
    for (const [file, text] of files) {
      let current: string | undefined;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        current = undefined;
      }
      if (current === text) continue;
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, text);
    }
    return null;
  } catch (error) {
    return `Writing the Gemini status extension in ${dir} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Remove // and /* *\/ comments outside strings: Gemini CLI's settings.json may contain them. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Whether Gemini CLI offers /voice: it is experimental and registered only with
 * experimental.voiceMode on. Without it Gemini sends "/voice" to the model as a prompt. A
 * workspace setting (<dir>/.gemini/settings.json) overrides the user one.
 */
export function isGeminiVoiceModeEnabled(home: string = os.homedir(), workspaceDir?: string): boolean {
  const read = (file: string): boolean | undefined => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return undefined; // no settings file
    }
    try {
      const value = JSON.parse(stripJsonComments(text))?.experimental?.voiceMode;
      return typeof value === "boolean" ? value : undefined;
    } catch (error) {
      console.error(`Error parsing Gemini settings ${file}:`, error);
      return undefined;
    }
  };
  const workspace = workspaceDir ? read(path.join(workspaceDir, ".gemini", "settings.json")) : undefined;
  return workspace ?? read(path.join(home, ".gemini", "settings.json")) ?? false;
}

/**
 * Gemini CLI keeps a project's chats under ~/.gemini/tmp/<id>/chats, where <id> is the slug
 * ~/.gemini/projects.json maps the directory to; older layouts use a hash folder. Every such
 * folder holds a .project_root file naming its directory, which is checked last.
 */
export function findGeminiChatDir(targetDir: string, home: string = os.homedir()): string | undefined {
  const tmpDir = path.join(home, ".gemini", "tmp");
  const wanted = path.resolve(targetDir);
  const chatsIfMatches = (name: string): string | undefined => {
    try {
      const rootPath = fs.readFileSync(path.join(tmpDir, name, ".project_root"), "utf8").trim();
      if (path.resolve(rootPath) !== wanted) return undefined;
      const chatsDir = path.join(tmpDir, name, "chats");
      return fs.existsSync(chatsDir) ? chatsDir : undefined;
    } catch {
      return undefined; // no .project_root: not a project folder
    }
  };

  try {
    const registry = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "projects.json"), "utf8"));
    const slug = registry?.projects?.[wanted];
    if (typeof slug === "string") {
      const found = chatsIfMatches(slug);
      if (found) return found;
    }
  } catch {
    // no or unreadable registry: fall back to scanning
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpDir, {withFileTypes: true});
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = chatsIfMatches(entry.name);
    if (found) return found;
  }
  return undefined;
}

// User messages Gemini CLI writes itself, not prompts the user typed: its context, and the note
// it adds when the user leaves plan mode with Shift+Tab (getPlanModeExitMessage)
const CONTEXT_PREFIXES = ["<session_context>", "<context>", "User has manually exited Plan Mode. Switching to "];

function partsText(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (Array.isArray(parts)) return parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join(" ");
  return "";
}

/**
 * The user's prompts and the last model of one Gemini chat. A .jsonl chat is a log: a metadata
 * line, message records (a later record with the same id replaces the earlier one), `$set` and
 * `$patch` updates, and `$rewindTo` records that drop that message and everything after it. A
 * .json chat holds the final `messages` array. The text shown to the user (displayContent) is
 * preferred over the content sent to the model, which has @file references expanded.
 */
export function parseGeminiChat(raw: string, jsonl: boolean): {prompts: string[]; model?: string} {
  let messages: any[] = [];
  let model: string | undefined;
  if (jsonl) {
    const byId = new Map<string, any>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // a half-written last line
      }
      if (!record || typeof record !== "object") continue;
      if (typeof record.$rewindTo === "string") {
        if (!byId.has(record.$rewindTo)) {
          byId.clear();
          continue;
        }
        let found = false;
        for (const id of [...byId.keys()]) {
          if (id === record.$rewindTo) found = true;
          if (found) byId.delete(id);
        }
      } else if (typeof record.id === "string" && typeof record.type === "string") {
        byId.set(record.id, record);
      }
    }
    messages = [...byId.values()];
  } else {
    const content = JSON.parse(raw);
    if (Array.isArray(content?.messages)) messages = content.messages;
    if (typeof content?.model === "string") model = content.model;
  }

  const prompts: string[] = [];
  for (const msg of messages) {
    if (msg.type === "user") {
      const text = partsText(msg.displayContent ?? msg.content).trim();
      if (text && !CONTEXT_PREFIXES.some(p => text.startsWith(p))) prompts.push(text);
    } else if (msg.type === "gemini" && typeof msg.model === "string") {
      model = msg.model;
    }
  }
  return {prompts, model};
}

/**
 * Prompts and model of a Gemini session. With a session id only that session's chat is read, so a
 * new session never shows another one's prompts; without one, the most recent chat of the directory.
 */
export function readGeminiPromptsAndModel(targetDir: string, home: string = os.homedir(), sessionUuid?: string): {prompts: string[]; model?: string} {
  const chatsDir = findGeminiChatDir(targetDir, home);
  if (!chatsDir) return {prompts: []};
  try {
    const names = fs.readdirSync(chatsDir).filter(f => f.startsWith("session-") && (f.endsWith(".jsonl") || f.endsWith(".json")));
    let file: string | undefined;
    if (sessionUuid) {
      // A resumed session keeps its file; on a name collision the newest one is the live chat
      const own = names.filter(f => isChatFileOf(f, sessionUuid)).sort();
      file = own[own.length - 1];
    } else {
      file = names
        .map(f => ({f, mtime: fs.statSync(path.join(chatsDir, f)).mtimeMs}))
        .sort((a, b) => b.mtime - a.mtime)[0]?.f;
    }
    if (!file) return {prompts: []};
    return parseGeminiChat(fs.readFileSync(path.join(chatsDir, file), "utf8"), file.endsWith(".jsonl"));
  } catch (error) {
    console.error(`Error reading Gemini chat in ${chatsDir}:`, error);
    return {prompts: []};
  }
}
