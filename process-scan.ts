import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ClaudeProcess {
  pid: number;
  cwd: string;
  sessionUuid?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FLAGS = ["--resume", "-r", "--session-id"];
const CLI_JS_SUFFIX = "@anthropic-ai/claude-code/cli.js";
// Env markers of Claude processes started by this app; the legacy FleetCode marker is kept for
// processes started before the rename to Agentyard.
const OWN_SESSION_ENV_PREFIXES = ["AGENTYARD_SESSION_ID=", "FLEETCODE_SESSION_ID="];

export function parseClaudeCmdline(argv: string[]): { isClaude: boolean; sessionUuid?: string } {
  if (argv.length === 0) return {isClaude: false};

  const isClaude = path.basename(argv[0]) === "claude" || argv.some(a => a.endsWith(CLI_JS_SUFFIX));
  if (!isClaude) return {isClaude: false};

  let sessionUuid: string | undefined;
  for (let i = 1; i < argv.length && !sessionUuid; i++) {
    const arg = argv[i];
    let value: string | undefined;
    if (SESSION_FLAGS.includes(arg)) {
      value = argv[i + 1];
    } else {
      const eq = arg.indexOf("=");
      if (eq > 0 && SESSION_FLAGS.includes(arg.slice(0, eq))) value = arg.slice(eq + 1);
    }
    if (value !== undefined && UUID_RE.test(value)) sessionUuid = value;
  }
  return {isClaude: true, sessionUuid};
}

function splitNul(buf: Buffer): string[] {
  const parts = buf.toString("utf-8").split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Claude Code's live-process registry: <home>/.claude/sessions/<pid>.json */
export function claudeSessionRegistryDir(home: string = os.homedir()): string {
  return path.join(home, ".claude", "sessions");
}

/** Start time of a process (field 22 of /proc/<pid>/stat); comm may contain spaces and ")". */
function procStartTime(procDir: string): string | undefined {
  try {
    const stat = fs.readFileSync(path.join(procDir, "stat"), "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/**
 * The conversation a Claude process has open, from the entry Claude Code keeps for it in its
 * session registry. The entry counts only when its procStart matches the running process, so an
 * entry left by an earlier process with a reused pid is ignored. Any doubt yields undefined.
 */
function registrySessionUuid(sessionsDir: string, pid: string, procDir: string): string | undefined {
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${pid}.json`), "utf-8"));
    if (typeof entry?.sessionId !== "string" || !UUID_RE.test(entry.sessionId)) return undefined;
    const start = procStartTime(procDir);
    if (entry.procStart === undefined || start === undefined || String(entry.procStart) !== start) return undefined;
    return entry.sessionId;
  } catch {
    return undefined;
  }
}

/**
 * `sessionsDir` defaults to Claude Code's registry only for the real /proc, so a test passing a
 * fake procRoot never reads the user's registry.
 */
export function scanClaudeProcesses(procRoot?: string, sessionsDir?: string): ClaudeProcess[] {
  if (!procRoot && process.platform !== "linux") return [];
  const root = procRoot ?? "/proc";
  const registry = sessionsDir ?? (procRoot ? undefined : claudeSessionRegistryDir());

  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }

  const result: ClaudeProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = path.join(root, entry);
    try {
      const argv = splitNul(fs.readFileSync(path.join(dir, "cmdline")));
      const parsed = parseClaudeCmdline(argv);
      if (!parsed.isClaude) continue;

      // Fail closed: the caller uses this list to lock directories. Agentyard-owned processes are
      // same-uid and always have a readable environ, so an unreadable environ cannot be ours and
      // the process is treated as external.
      let env: string[] = [];
      try {
        env = splitNul(fs.readFileSync(path.join(dir, "environ")));
      } catch {
        // unreadable environ: keep as external
      }
      if (env.some(e => OWN_SESSION_ENV_PREFIXES.some(prefix => e.startsWith(prefix)))) continue;

      const cwd = fs.readlinkSync(path.join(dir, "cwd")).replace(/ \(deleted\)$/, "");
      // A uuid-less command line (plain `claude`) is identified from Claude Code's registry
      const sessionUuid = parsed.sessionUuid ?? (registry ? registrySessionUuid(registry, entry, dir) : undefined);
      result.push({pid: Number(entry), cwd, sessionUuid});
    } catch {
      // pid vanished or not permitted: skip silently
    }
  }
  return result;
}
