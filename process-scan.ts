import * as fs from "fs";
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

export function scanClaudeProcesses(procRoot?: string): ClaudeProcess[] {
  if (!procRoot && process.platform !== "linux") return [];
  const root = procRoot ?? "/proc";

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
      result.push({pid: Number(entry), cwd, sessionUuid: parsed.sessionUuid});
    } catch {
      // pid vanished or not permitted: skip silently
    }
  }
  return result;
}
