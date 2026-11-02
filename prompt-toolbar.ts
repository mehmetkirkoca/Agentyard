import * as fs from "fs";
import * as path from "path";

/** Claude Code permission modes, as --permission-mode names them. */
export type PermissionMode = "manual" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";

/** Modes offered in the toolbar menu, in Shift+Tab order of the footer text Claude Code shows. */
export const PERMISSION_MODES: {mode: PermissionMode; label: string; icon: string}[] = [
  {mode: "manual", label: "Manual", icon: "✋"},
  {mode: "acceptEdits", label: "Accept edits", icon: "✎"},
  {mode: "plan", label: "Plan", icon: "⏸"},
  {mode: "auto", label: "Auto", icon: "⏵"},
  {mode: "bypassPermissions", label: "Bypass", icon: "⏵⏵"},
];

const MODE_FOOTERS: [RegExp, PermissionMode][] = [
  [/bypass permissions on/i, "bypassPermissions"],
  [/accept edits on/i, "acceptEdits"],
  [/plan mode on/i, "plan"],
  [/auto mode on/i, "auto"],
  [/don'?t ask (mode )?on/i, "dontAsk"],
];

/**
 * The permission mode shown in Claude Code's footer (the last lines of the terminal).
 * The lowest matching line wins; no mode line means manual.
 */
export function parsePermissionMode(lines: string[]): PermissionMode {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [pattern, mode] of MODE_FOOTERS) {
      if (pattern.test(lines[i])) return mode;
    }
  }
  return "manual";
}

/** Models offered in the toolbar menu; the alias is what /model takes. */
export const MODEL_CHOICES: {alias: string; label: string}[] = [
  {alias: "fable", label: "Fable 5.1"},
  {alias: "opus", label: "Opus 5.5"},
  {alias: "sonnet", label: "Sonnet 5.5"},
  {alias: "haiku", label: "Haiku 5.5"},
];

/** Gemini CLI model aliases (what `/model set` and `-m` take); Gemini resolves them to a concrete model. */
export const GEMINI_MODEL_CHOICES: {alias: string; label: string}[] = [
  {alias: "auto", label: "Auto"},
  {alias: "pro", label: "Pro"},
  {alias: "flash", label: "Flash"},
  {alias: "flash-lite", label: "Flash Lite"},
];

/** Gemini CLI approval modes, as --approval-mode names them. */
export type GeminiApprovalMode = "default" | "auto_edit" | "plan" | "yolo";

/** Modes offered in the toolbar menu: Shift+Tab cycles the first three, Ctrl+Y toggles YOLO. */
export const GEMINI_PERMISSION_MODES: {mode: GeminiApprovalMode; label: string; icon: string}[] = [
  {mode: "default", label: "Default", icon: "✋"},
  {mode: "auto_edit", label: "Auto edit", icon: "✎"},
  {mode: "plan", label: "Plan", icon: "⏸"},
  {mode: "yolo", label: "YOLO", icon: "⏵⏵"},
];

// The mode line above Gemini CLI's input box starts with the mode name, then the key hint for the
// next one; anchored at the line start so text typed in the input box below never matches
const GEMINI_MODE_FOOTERS: [RegExp, GeminiApprovalMode][] = [
  [/^\s*YOLO\s+Ctrl\+Y\b/i, "yolo"],
  [/^\s*auto-accept edits\s+Shift\+Tab to/i, "auto_edit"],
  [/^\s*plan\s+Shift\+Tab to manual/i, "plan"],
  [/^\s*Shift\+Tab to accept edits/i, "default"],
];

/**
 * The approval mode shown on Gemini CLI's mode line (the last lines of the terminal). The lowest
 * matching line wins; undefined when no mode line is on screen (e.g. while a dialog is open).
 */
export function parseGeminiApprovalMode(lines: string[]): GeminiApprovalMode | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [pattern, mode] of GEMINI_MODE_FOOTERS) {
      if (pattern.test(lines[i])) return mode;
    }
  }
  return undefined;
}

/**
 * Next key toward `target` from `current`: Ctrl+Y toggles YOLO (and leaves it for default),
 * Shift+Tab cycles default -> auto_edit -> plan -> default. Null when already there.
 */
export function geminiModeKey(current: GeminiApprovalMode, target: GeminiApprovalMode): "\x19" | "\x1b[Z" | null {
  if (current === target) return null;
  if (current === "yolo" || target === "yolo") return "\x19";
  return "\x1b[Z";
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** "claude-opus-5-5" -> "Opus 5.5"; unknown ids are returned unchanged. */
export function modelLabel(id: string): string {
  const geminiAlias = GEMINI_MODEL_CHOICES.find(c => c.alias === id);
  if (geminiAlias) return geminiAlias.label;
  // "gemini-3.5-flash-lite" -> "Gemini 3.5 Flash Lite"
  if (id.toLowerCase().startsWith("gemini")) {
    return id
      .split("-")
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (!match) return id;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return `${family} ${match[2]}.${match[3]}`;
}

/** Model and effort of the last assistant reply in a transcript; size is the consumed byte offset. */
export interface SessionModel {
  size: number;
  model?: string;
  effort?: string;
}

/** Fold parsed transcript lines into the model state. Unparseable lines are skipped. */
export function applyModelLines(state: SessionModel, lines: string[]): SessionModel {
  const next: SessionModel = {...state};
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "assistant") continue;
      const model = entry.message?.model;
      // "<synthetic>" marks locally generated messages (errors, interrupts), not a model reply
      if (typeof model !== "string" || model.startsWith("<")) continue;
      next.model = model;
      if (typeof entry.effort === "string") next.effort = entry.effort;
    } catch {
      // skip unparseable line
    }
  }
  return next;
}

/**
 * Read the model state from a transcript, continuing from prev.size when the file only grew.
 * Only complete lines (up to the last newline) are consumed. Errors name the file.
 */
export function readSessionModel(filePath: string, prev?: SessionModel): SessionModel {
  try {
    const size = fs.statSync(filePath).size;
    const base: SessionModel = prev && prev.size <= size ? prev : {size: 0};
    const length = size - base.size;
    if (length <= 0) return base;

    const buf = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    let bytesRead = 0;
    try {
      while (bytesRead < length) {
        const n = fs.readSync(fd, buf, bytesRead, length - bytesRead, base.size + bytesRead);
        if (n === 0) break;
        bytesRead += n;
      }
    } finally {
      fs.closeSync(fd);
    }

    const lastNewline = buf.lastIndexOf(0x0a, bytesRead - 1);
    if (lastNewline < 0) return base;
    const consumed = lastNewline + 1;
    const lines = buf.toString("utf8", 0, consumed).split("\n");
    return {...applyModelLines(base, lines), size: base.size + consumed};
  } catch (err) {
    throw new Error(`Reading the model failed for ${filePath}: ${(err as Error).message}`);
  }
}

export interface SlashCommand {
  name: string;
  description: string;
  source: "built-in" | "user" | "project" | "plugin";
}

const BUILT_IN_COMMANDS: [string, string][] = [
  ["add-dir", "Add a working directory"],
  ["agents", "Manage agents"],
  ["clear", "Clear the conversation"],
  ["compact", "Compact the conversation"],
  ["config", "Open settings"],
  ["context", "Show context usage"],
  ["cost", "Show token usage and cost"],
  ["effort", "Set effort level"],
  ["export", "Export the conversation"],
  ["help", "Show help"],
  ["hooks", "Manage hooks"],
  ["init", "Create a CLAUDE.md"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Edit memory files"],
  ["model", "Choose the model"],
  ["permissions", "Manage permissions"],
  ["resume", "Resume a conversation"],
  ["rewind", "Rewind the conversation"],
  ["status", "Show status"],
  ["voice", "Toggle voice mode"],
];

/** The description from a command / SKILL.md frontmatter, else its first non-empty line. */
export function parseCommandDescription(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front) {
    const line = /^description:\s*(.*)$/m.exec(front[1]);
    if (line) return line[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const body = front ? text.slice(front[0].length) : text;
  const first = body.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? "";
  return first.replace(/^#+\s*/, "");
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return [];
  }
}

/** <dir>/commands/*.md and <dir>/skills/<name>/SKILL.md, names prefixed with prefix. */
function commandsUnder(dir: string, prefix: string, source: SlashCommand["source"]): SlashCommand[] {
  const found: SlashCommand[] = [];
  for (const entry of listDir(path.join(dir, "commands"))) {
    if (!entry.name.endsWith(".md")) continue;
    const text = readText(path.join(dir, "commands", entry.name));
    if (text === undefined) continue;
    found.push({name: prefix + entry.name.slice(0, -3), description: parseCommandDescription(text), source});
  }
  for (const entry of listDir(path.join(dir, "skills"))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const text = readText(path.join(dir, "skills", entry.name, "SKILL.md"));
    if (text === undefined) continue;
    found.push({name: prefix + entry.name, description: parseCommandDescription(text), source});
  }
  return found;
}

function enabledPluginDirs(home: string): [string, string][] {
  const dirs: [string, string][] = [];
  let installed: any;
  let settings: any;
  try {
    installed = JSON.parse(readText(path.join(home, ".claude/plugins/installed_plugins.json")) ?? "{}");
    settings = JSON.parse(readText(path.join(home, ".claude/settings.json")) ?? "{}");
  } catch (error) {
    console.error("Reading the plugin list failed:", error);
    return dirs;
  }
  const enabled = settings?.enabledPlugins ?? {};
  for (const [key, installs] of Object.entries<any>(installed?.plugins ?? {})) {
    if (enabled[key] !== true || !Array.isArray(installs)) continue;
    const installPath = installs.find((i: any) => typeof i?.installPath === "string")?.installPath;
    if (installPath) dirs.push([key.split("@")[0], installPath]);
  }
  return dirs;
}

/**
 * Slash commands Claude Code offers in a session: built-ins, user and project commands and skills,
 * and the commands and skills of enabled plugins (as plugin:name). A project entry replaces a
 * user entry of the same name. Sorted by name.
 */
export function listSlashCommands(opts: {home: string; projectDir?: string}): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  const add = (list: SlashCommand[]) => list.forEach(c => byName.set(c.name, c));
  add(BUILT_IN_COMMANDS.map(([name, description]) => ({name, description, source: "built-in" as const})));
  for (const [plugin, dir] of enabledPluginDirs(opts.home)) add(commandsUnder(dir, `${plugin}:`, "plugin"));
  add(commandsUnder(path.join(opts.home, ".claude"), "", "user"));
  if (opts.projectDir) add(commandsUnder(path.join(opts.projectDir, ".claude"), "", "project"));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Gemini CLI built-in commands (v0.66), with their own descriptions shortened. */
export const GEMINI_BUILT_IN_COMMANDS: [string, string][] = [
  ["about", "Show version info"],
  ["agents", "Manage agents"],
  ["auth", "Sign in or change the authentication method"],
  ["chat", "Manage conversation checkpoints"],
  ["clear", "Clear the screen and start a new session"],
  ["commands", "Manage custom slash commands"],
  ["compress", "Replace the context with a summary"],
  ["copy", "Copy the last result to the clipboard"],
  ["directory", "Manage workspace directories"],
  ["export-session", "Export the session to a JSON file"],
  ["extensions", "Manage extensions"],
  ["help", "Show help"],
  ["hooks", "Manage hooks"],
  ["init", "Create a GEMINI.md"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Manage memory"],
  ["model", "Choose the model"],
  ["permissions", "Manage folder trust and permissions"],
  ["plan", "Switch to plan mode"],
  ["policies", "Manage policies"],
  ["resume", "Resume a conversation"],
  ["rewind", "Rewind the conversation"],
  ["settings", "View and edit settings"],
  ["skills", "Manage agent skills"],
  ["stats", "Show session stats"],
  ["tools", "List available tools"],
  ["voice", "Toggle voice dictation"],
];

/** `description = "..."` of a Gemini command TOML file, else "" (Gemini then shows a default). */
export function parseTomlDescription(text: string): string {
  const match = /^\s*description\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m.exec(text);
  if (!match) return "";
  return match[1] !== undefined ? match[1].replace(/\\(["\\])/g, "$1") : match[2];
}

/**
 * Gemini CLI custom commands: <dir>/**\/*.toml, a subfolder adding a "folder:" namespace, plus
 * <skillsDir>/<name>/SKILL.md skills, which Gemini also offers as slash commands.
 */
function geminiCommandsUnder(commandsDir: string, skillsDirs: string[], source: SlashCommand["source"]): SlashCommand[] {
  const found: SlashCommand[] = [];
  const walk = (dir: string, namespace: string[]) => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, [...namespace, entry.name]);
      else if (entry.name.endsWith(".toml")) {
        const text = readText(full);
        if (text === undefined) continue;
        const name = [...namespace, entry.name.slice(0, -5)].join(":");
        found.push({name, description: parseTomlDescription(text) || `Custom command from ${entry.name}`, source});
      }
    }
  };
  walk(commandsDir, []);
  for (const skillsDir of skillsDirs) {
    for (const entry of listDir(skillsDir)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const text = readText(path.join(skillsDir, entry.name, "SKILL.md"));
      if (text === undefined) continue;
      found.push({name: entry.name, description: parseCommandDescription(text), source});
    }
  }
  return found;
}

/**
 * Slash commands Gemini CLI offers in a session: built-ins, then user (~/.gemini, ~/.agents) and
 * project (.gemini, .agents) commands and skills. A project entry replaces a user entry of the
 * same name. Sorted by name.
 */
export function listGeminiSlashCommands(opts: {home: string; projectDir?: string}): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  const add = (list: SlashCommand[]) => list.forEach(c => byName.set(c.name, c));
  add(GEMINI_BUILT_IN_COMMANDS.map(([name, description]) => ({name, description, source: "built-in" as const})));
  const addFrom = (root: string, source: SlashCommand["source"]) => add(geminiCommandsUnder(
    path.join(root, ".gemini", "commands"),
    [path.join(root, ".gemini", "skills"), path.join(root, ".agents", "skills")],
    source,
  ));
  addFrom(opts.home, "user");
  if (opts.projectDir) addFrom(opts.projectDir, "project");
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Antigravity CLI built-in commands (1.4.12), with the descriptions its menu shows, shortened. */
export const ANTIGRAVITY_BUILT_IN_COMMANDS: [string, string][] = [
  ["add-dir", "Add a directory to the workspace"],
  ["agents", "List available custom agents"],
  ["artifact", "View and review artifacts"],
  ["boost", "Invoke the Boost multi-agent orchestrator"],
  ["browser", "Invoke a browser agent for web tasks"],
  ["btw", "Ask a side question without interrupting"],
  ["changelog", "Show release notes and changes"],
  ["clear", "Clear conversation and start a new one"],
  ["compact", "Compact the conversation now"],
  ["config", "Open settings panel"],
  ["context", "Visualize current context usage"],
  ["copy", "Copy the last planner response"],
  ["credits", "Show remaining credits"],
  ["diff", "View uncommitted changes and per-turn diffs"],
  ["effort", "Set the reasoning effort"],
  ["exit", "Exit the CLI"],
  ["feedback", "Submit feedback"],
  ["fork", "Create a branch of the current conversation"],
  ["goal", "Run until the goal is completely finished"],
  ["help", "Show available commands and keybindings"],
  ["hooks", "Manage hook configurations"],
  ["keybindings", "Set custom keybindings"],
  ["learn", "Capture reusable skills or rules"],
  ["logout", "Log out"],
  ["mcp", "Manage MCP servers"],
  ["model", "Set a model"],
  ["open", "Open a file or view opened/edited files"],
  ["permissions", "Manage tool permissions"],
  ["plan", "Plan carefully before executing a task"],
  ["plugin", "Manage plugins"],
  ["remote-control", "Turn on remote control for this session"],
  ["rename", "Rename the current conversation"],
  ["resume", "Browse and resume past conversations"],
  ["rewind", "Rewind conversation to a previous message"],
  ["schedule", "Run an instruction on a schedule or timer"],
  ["skills", "List available skills"],
  ["statusline", "Toggle the statusline"],
  ["tasks", "View background tasks"],
  ["teamwork", "Invoke a team of agents"],
  ["title", "Toggle custom terminal window title"],
  ["usage", "View model quota usage"],
  ["voice", "Dictate a prompt using your microphone"],
];

function frontmatterField(text: string, key: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = front && new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front[1]);
  return line ? line[1].trim().replace(/^(["'])(.*)\1$/, "$2") : undefined;
}

/** <dir>/<name>/SKILL.md as slash commands, named by their frontmatter name (else the folder). */
function agySkillsUnder(dir: string, prefix: string, source: SlashCommand["source"]): SlashCommand[] {
  const found: SlashCommand[] = [];
  for (const entry of listDir(dir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const text = readText(path.join(dir, entry.name, "SKILL.md"));
    if (text === undefined || frontmatterField(text, "disable-slash-command") === "true") continue;
    const name = prefix + (frontmatterField(text, "name") || entry.name);
    found.push({name, description: parseCommandDescription(text), source});
  }
  return found;
}

function enabledAgyPlugins(home: string): string[] {
  try {
    const primary = path.join(home, ".gemini/config/config.json");
    const snap = path.join(home, "snap/antigravity-cli/common/.gemini/config/config.json");
    const file = fs.existsSync(primary) ? primary : fs.existsSync(snap) ? snap : primary;
    const config = JSON.parse(readText(file) ?? "{}");
    return Object.entries<any>(config?.plugins ?? {}).filter(([, p]) => p?.enabled === true).map(([name]) => name);
  } catch (error) {
    console.error("Reading the Antigravity plugin list failed:", error);
    return [];
  }
}

/**
 * Slash commands Antigravity CLI offers: built-ins, its builtin skills, user skills
 * (~/.gemini/config/skills), skills of enabled plugins (as plugin:name) and project skills
 * (.agents/skills). A built-in command keeps its name over a skill; a project skill replaces a user
 * one. Sorted by name.
 */
export function listAntigravitySlashCommands(opts: {home: string; projectDir?: string}): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  // Built-ins come first and are never replaced
  const add = (list: SlashCommand[]) => list.forEach(c => {
    if (byName.get(c.name)?.source !== "built-in") byName.set(c.name, c);
  });
  add(ANTIGRAVITY_BUILT_IN_COMMANDS.map(([name, description]) => ({name, description, source: "built-in" as const})));

  const builtinSkills = [
    path.join(opts.home, ".gemini/antigravity-cli/builtin/skills"),
    path.join(opts.home, "snap/antigravity-cli/common/.gemini/antigravity-cli/builtin/skills"),
  ].find(p => fs.existsSync(p)) ?? path.join(opts.home, ".gemini/antigravity-cli/builtin/skills");
  add(agySkillsUnder(builtinSkills, "", "built-in"));

  const configDir = [
    path.join(opts.home, ".gemini/config"),
    path.join(opts.home, "snap/antigravity-cli/common/.gemini/config"),
  ].find(p => fs.existsSync(p)) ?? path.join(opts.home, ".gemini/config");
  add(agySkillsUnder(path.join(configDir, "skills"), "", "user"));
  for (const plugin of enabledAgyPlugins(opts.home)) {
    add(agySkillsUnder(path.join(configDir, "plugins", plugin, "skills"), `${plugin}:`, "plugin"));
  }
  if (opts.projectDir) add(agySkillsUnder(path.join(opts.projectDir, ".agents/skills"), "", "project"));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
