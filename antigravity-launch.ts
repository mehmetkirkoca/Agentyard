import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {HookEvent} from "./session-status";
import {resolveSessionTitle} from "./transcript-meta";

/**
 * The agy binary to run. ~/.gemini/bin/agy is the self-updating install (1.4.12+); an agy found
 * on PATH may be an old copy (1.1.10 lacks --settings and other flags), so it is the fallback.
 */
export function resolveAgyBinary(
  home: string = os.homedir(),
  isExecutable: (p: string) => boolean = canExecute,
): string {
  const managed = path.join(home, ".gemini", "bin", "agy");
  return isExecutable(managed) ? managed : "agy";
}

function canExecute(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const shellQuote = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;

// agy's conversation ids are uuids. They are read back from the status file, which tools agy runs
// can also write to, so anything else is never used (and never typed into the shell).
const AGY_CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAgyConversationId(id: unknown): id is string {
  return typeof id === "string" && AGY_CONVERSATION_ID_RE.test(id);
}

/** The command typed into the session's shell. Without a conversation id agy starts a new one. */
export function buildAgyCommand(opts: {binary: string; conversationId?: string; skipPermissions: boolean}): string {
  const parts = [opts.binary === "agy" ? "agy" : shellQuote(opts.binary)];
  if (isAgyConversationId(opts.conversationId)) parts.push(`--conversation ${opts.conversationId}`);
  if (opts.skipPermissions) parts.push("--dangerously-skip-permissions");
  return parts.join(" ");
}

export function agyTranscriptPath(conversationId: string, home: string = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
}

// agy wraps what the user typed as <USER_REQUEST>…</USER_REQUEST>, followed by its own metadata
const USER_REQUEST_RE = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/;

/** The user's prompts in a transcript: USER_INPUT steps, the text inside USER_REQUEST. */
export function parseAgyTranscript(raw: string): string[] {
  const prompts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let step: any;
    try {
      step = JSON.parse(line);
    } catch {
      continue; // a half-written last line
    }
    if (step?.type !== "USER_INPUT" || typeof step.content !== "string") continue;
    const match = USER_REQUEST_RE.exec(step.content);
    const text = match?.[1].trim();
    if (text) prompts.push(text);
  }
  return prompts;
}

/** Prompts of an agy conversation; empty before its first prompt (no id yet) or without a transcript. */
export function readAgyPrompts(conversationId: string | undefined, home: string = os.homedir()): string[] {
  if (!conversationId) return [];
  const file = agyTranscriptPath(conversationId, home);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Error reading agy transcript ${file}:`, error);
    return [];
  }
  return parseAgyTranscript(raw);
}

/** The fields of a session that tell its agy conversation and the one it was forked from. */
export interface AgyForkInfo {
  agentConversationId?: string;
  forkedFrom?: string;
  forkedPromptCount?: number;
}

/**
 * Prompts of an agy session that may be a fork. agy's /fork carries the conversation over but its
 * transcript holds only the steps after the fork, so the original's first forkedPromptCount prompts
 * (as many as it had when forked) come first. The original is looked up among the sessions, so a
 * fork of a fork includes what its original inherited; without that session its transcript is read.
 */
export function agyPromptsOf(
  session: AgyForkInfo,
  sessions: AgyForkInfo[],
  read: (conversationId: string | undefined) => string[] = id => readAgyPrompts(id),
  depth = 0,
): string[] {
  const own = read(session.agentConversationId);
  if (!session.forkedFrom || !session.forkedPromptCount || depth > 20) return own;
  const original = sessions.find(s => s.agentConversationId === session.forkedFrom);
  const inherited = original ? agyPromptsOf(original, sessions, read, depth + 1) : read(session.forkedFrom);
  return [...inherited.slice(0, session.forkedPromptCount), ...own];
}

const SIMPLE_ESCAPES: Record<string, string> = {n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\"};

/**
 * The title in an agy annotations file (protobuf text: `title:"…" last_user_view_time:{…}`).
 * Escapes are decoded as bytes, so octal/hex-escaped UTF-8 comes out as the characters it encodes.
 */
export function parseAgyAnnotationTitle(text: string): string | undefined {
  const match = /(?:^|\s)title:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!match) return undefined;
  const raw = match[1];
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      bytes.push(...Buffer.from(raw[i], "utf8"));
      continue;
    }
    const next = raw[++i];
    const octal = /^[0-7]{1,3}/.exec(raw.slice(i));
    const hex = next === "x" ? /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 1)) : null;
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += octal[0].length - 1;
    } else if (hex) {
      bytes.push(parseInt(hex[0], 16));
      i += hex[0].length;
    } else {
      bytes.push(...Buffer.from(SIMPLE_ESCAPES[next] ?? next ?? "", "utf8"));
    }
  }
  const title = Buffer.from(bytes).toString("utf8").trim();
  return title || undefined;
}

/** The title agy gave a conversation (~/.gemini/antigravity-cli/annotations/<id>.pbtxt), if any yet. */
export function readAgyTitle(conversationId: string | undefined, home: string = os.homedir()): string | undefined {
  if (!isAgyConversationId(conversationId)) return undefined;
  const file = path.join(home, ".gemini", "antigravity-cli", "annotations", `${conversationId}.pbtxt`);
  try {
    return parseAgyAnnotationTitle(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Error reading agy title ${file}:`, error);
    return undefined;
  }
}

/**
 * The automatic name of an agy session, as for Claude: agy's own title of the conversation, else its
 * first prompt; one line of at most 60 characters. Undefined before the first prompt.
 */
export function agySessionName(
  session: AgyForkInfo,
  sessions: AgyForkInfo[],
  readTitle: (conversationId: string | undefined) => string | undefined = id => readAgyTitle(id),
  readPrompts: (conversationId: string | undefined) => string[] = id => readAgyPrompts(id),
): string | undefined {
  return resolveSessionTitle({
    uuid: "",
    size: 0,
    mtimeMs: 0,
    aiTitle: readTitle(session.agentConversationId),
    firstPrompt: agyPromptsOf(session, sessions, readPrompts)[0],
  });
}

/** What agy shows above an approval prompt ("Requesting permission for:\n   <command>\nRun this command?"). */
export const AGY_PERMISSION_SIGNATURE = "Requesting permission for:";

// CSI, OSC and charset escapes; what is left is the text agy draws
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
const WAITING_WINDOW = 4096;

/**
 * agy sends no hook while it waits for approval, so its PTY output is watched for the approval
 * screen. The text is kept across chunks (a signature may be split, also by colour codes) in a
 * small window; a hit clears the window so one screen is reported once.
 */
export function createAgyWaitingDetector(): (chunk: string) => boolean {
  let pendingEscape = "";
  let text = "";
  return (chunk: string) => {
    // An escape sequence cut at the chunk end waits for the rest before it is removed
    let data = pendingEscape + chunk;
    pendingEscape = "";
    const lastEsc = data.lastIndexOf("\x1b");
    if (lastEsc >= 0 && lastEsc > data.length - 32 && !/[@-~\x07]/.test(data.slice(lastEsc + 2))) {
      pendingEscape = data.slice(lastEsc);
      data = data.slice(0, lastEsc);
    }
    text = (text + data.replace(ANSI_RE, "")).slice(-WAITING_WINDOW);
    if (!text.includes(AGY_PERMISSION_SIGNATURE)) return false;
    text = "";
    return true;
  };
}

/**
 * Which hook events belong to the session's conversation. agy's sub-agents may report their own
 * conversation ids into the same status file; they must not replace the session's id nor its
 * status. The id is taken from the first event when none is known, and otherwise changes only on
 * SessionStart (a new top-level conversation, e.g. after /clear or a missing --conversation id).
 */
export function filterAgyEvents(
  currentId: string | undefined,
  events: HookEvent[],
): {conversationId: string | undefined; accepted: HookEvent[]} {
  let conversationId = currentId;
  const accepted: HookEvent[] = [];
  for (const ev of events) {
    const id = ev.conversationId;
    if (id !== undefined && !isAgyConversationId(id)) continue;
    if (id && (!conversationId || ev.hook_event_name === "SessionStart")) conversationId = id;
    if (!id || id === conversationId) accepted.push(ev);
  }
  return {conversationId, accepted};
}

/**
 * A session's fork fields once its agy conversation is id. The first id a fork learns keeps what it
 * inherits from the original; a later change (/clear, or a resumed id agy no longer has) starts a
 * conversation without that history, so the inheritance goes. A fork never takes the original's own
 * id: that only comes when /fork was not sent, and the fork would then write into the original.
 */
export function adoptAgyConversation(session: AgyForkInfo, id: string): AgyForkInfo {
  if (session.agentConversationId === id) return session;
  if (!session.agentConversationId) {
    return session.forkedFrom === id ? session : {...session, agentConversationId: id};
  }
  return {agentConversationId: id};
}

/** Text without terminal escapes, as agy draws it. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** The agy plugin through which Agentyard receives hook events (agy loads hooks only from hooks.json files). */
export const AGY_STATUS_PLUGIN = "agentyard-status";
/** Set in the PTY of an agy session Agentyard starts: the status file its hooks append to. */
export const AGY_STATUS_ENV = "AGENTYARD_STATUS_FILE";

const AGY_SIMPLE_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop"];
const AGY_TOOL_EVENTS = ["PreToolUse", "PostToolUse"];

/**
 * Hook command for one event. agy's hook input has no event name, so the name is fixed in the
 * command. When the session's status file exists, one line is appended with only the fields the
 * status logic reads: {"hook_event_name":…, "conversationId":…, "fullyIdle":…}. In any other agy
 * session (not started by Agentyard) the input is drained and nothing is written. Nothing goes to
 * stdout, so agy keeps its default behaviour.
 */
export function buildAgyHookCommand(event: string): string {
  const fields = `grep -oE '"(conversationId|fullyIdle)" *: *("[^"]*"|true|false)' | sed 's/^/,/' | tr -d '\\n'`;
  return `f="$${AGY_STATUS_ENV}"; if [ -n "$f" ] && [ -f "$f" ]; then `
    + `printf '{"hook_event_name":"%s"%s}\\n' '${event}' "$(${fields})" >> "$f"; else cat > /dev/null; fi`;
}

export function buildAgyStatusPlugin(): {manifest: object; hooks: object} {
  const handler = (event: string) => ({type: "command", command: buildAgyHookCommand(event)});
  const events: Record<string, object[]> = {};
  for (const event of AGY_SIMPLE_EVENTS) events[event] = [handler(event)];
  for (const event of AGY_TOOL_EVENTS) events[event] = [{matcher: "*", hooks: [handler(event)]}];
  return {
    manifest: {
      name: AGY_STATUS_PLUGIN,
      version: "1.0.0",
      description: "Reports session status to Agentyard; does nothing in sessions Agentyard did not start",
    },
    hooks: {[AGY_STATUS_PLUGIN]: events},
  };
}

function agyPluginFiles(): [string, string][] {
  const {manifest, hooks} = buildAgyStatusPlugin();
  // hooks.json must sit at the plugin root: agy does not load hooks/hooks.json
  return [
    ["plugin.json", JSON.stringify(manifest, null, 2) + "\n"],
    ["hooks.json", JSON.stringify(hooks, null, 2) + "\n"],
  ];
}

function readOrUndefined(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Write the plugin's files into dir; true when a file was missing or its content changed. */
export function writeAgyStatusPlugin(dir: string): boolean {
  let changed = false;
  fs.mkdirSync(dir, {recursive: true});
  for (const [name, text] of agyPluginFiles()) {
    const file = path.join(dir, name);
    if (readOrUndefined(file) === text) continue;
    fs.writeFileSync(file, text);
    changed = true;
  }
  return changed;
}

export type AgyPluginResult = {ok: true} | {ok: false; reason: "disabled" | "failed"; message: string};
export type AgyRun = (args: string[]) => {status: number | null; stdout: string; stderr: string};

/**
 * Make sure agy has the current agentyard-status plugin: written to sourceDir, then installed with
 * `agy plugin install` when missing or when the installed copy differs. A plugin the user disabled
 * is left alone (never re-enabled or reinstalled). Never throws.
 */
export function ensureAgyStatusPlugin(opts: {binary: string; sourceDir: string; run: AgyRun}): AgyPluginResult {
  const failed = (message: string): AgyPluginResult => ({ok: false, reason: "failed", message});
  try {
    writeAgyStatusPlugin(opts.sourceDir);
    const list = opts.run(["plugin", "list", "--json"]);
    if (list.status !== 0) return failed(`"${opts.binary} plugin list" failed: ${list.stderr.trim() || `exit ${list.status}`}`);
    const entry = (JSON.parse(list.stdout) as any[]).find(p => p?.name === AGY_STATUS_PLUGIN);
    if (entry?.enabled === false) {
      return {ok: false, reason: "disabled", message: `The ${AGY_STATUS_PLUGIN} plugin is disabled in Antigravity`};
    }
    const upToDate = entry && typeof entry.path === "string"
      && agyPluginFiles().every(([name, text]) => readOrUndefined(path.join(entry.path, name)) === text);
    if (upToDate) return {ok: true};
    const install = opts.run(["plugin", "install", opts.sourceDir]);
    if (install.status !== 0) {
      return failed(`Installing the ${AGY_STATUS_PLUGIN} plugin failed: ${install.stderr.trim() || `exit ${install.status}`}`);
    }
    return {ok: true};
  } catch (error) {
    return failed(`Setting up the ${AGY_STATUS_PLUGIN} plugin failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
