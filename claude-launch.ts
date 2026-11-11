import * as fs from "fs";
import * as path from "path";
import {quotePath} from "./attach-utils";

/**
 * Env vars set by a parent Claude Code process. When inherited by a nested
 * claude they silently disable transcript writing, so they are stripped.
 */
export const INHERITED_CLAUDE_ENV_KEYS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "npm_config_prefix",
  "NPM_CONFIG_PREFIX",
];

export function buildPtyEnv(base: NodeJS.ProcessEnv, appSessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...base};
  for (const key of INHERITED_CLAUDE_ENV_KEYS) {
    delete env[key];
  }
  env.AGENTYARD_SESSION_ID = appSessionId;
  return env;
}

/**
 * Hook command: append one JSON line holding only the fields the status logic
 * reads (event name, session id, notification type). Full payloads (tool input
 * and output) are never stored. Uses grep and paste from the login shell.
 */
export function buildHookCommand(statusFile: string): string {
  const fields = `grep -oE '"(hook_event_name|session_id|notification_type)" *: *"[^"]*"' | paste -sd, -`;
  return `printf '{%s}\\n' "$(${fields})" >> '${statusFile}'`;
}

// Claude's wheel speed in fullscreen (xterm's own sensitivity does not reach it: there every wheel
// event goes to Claude as one report). 0 = Default: Claude's or the user's own value stays.
export function claudeScrollEnv(level: unknown): NodeJS.ProcessEnv {
  const valid = typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 20;
  return valid ? {CLAUDE_CODE_SCROLL_SPEED: String(level)} : {};
}

/**
 * Claude Code runs this as its status line and passes its status JSON on stdin. The latest JSON
 * carrying the account's usage limits (`rate_limits`) is kept in `limitsFile` for the sidebar; the
 * user's own status line, its command in the file named by the first argument, still gets the JSON
 * and prints what it prints. Without one it prints nothing, as Claude shows without a status line.
 */
export function buildStatusLineScript(limitsFile: string): string {
  return `#!/bin/sh
# Agentyard: Claude Code's status line (statusLine in the session's --settings file).
f=${quotePath(limitsFile)}
input=$(cat)
case "$input" in
  *'"rate_limits"'*)
    mkdir -p "$(dirname "$f")" && printf '%s\n' "$input" > "$f.$$.tmp" && mv -f "$f.$$.tmp" "$f" ;;
esac
if [ -n "$1" ] && [ -s "$1" ]; then
  if command -v bash >/dev/null 2>&1; then
    printf '%s\n' "$input" | bash -c "$(cat "$1")"
  else
    printf '%s\n' "$input" | sh -c "$(cat "$1")"
  fi
fi
exit 0
`;
}

/** The statusLine command: run through sh, so the script needs no exec bit. */
export function buildStatusLineCommand(scriptPath: string, nextFile?: string): string {
  return `sh ${quotePath(scriptPath)}${nextFile ? ` ${quotePath(nextFile)}` : ""}`;
}

export function buildHookSettings(
  statusFile: string,
  opts: {disableFullscreen?: boolean; statusLine?: {command: string; padding?: number}} = {},
): object {
  const command = buildHookCommand(statusFile);
  const hooks = [{type: "command", command}];
  return {
    // Overrides "tui": "fullscreen" of the user's settings: the normal screen has scrollback
    ...(opts.disableFullscreen ? {tui: "default"} : {}),
    // Replaces the user's status line; the script hands the JSON on to it (buildStatusLineScript)
    ...(opts.statusLine ? {statusLine: {type: "command", ...opts.statusLine}} : {}),
    hooks: {
      UserPromptSubmit: [{hooks}],
      PostToolUse: [{matcher: "*", hooks}],
      Notification: [{hooks}],
      Stop: [{hooks}],
    },
  };
}

export function buildClaudeCommand(opts: {
  sessionUuid: string;
  isNew: boolean;
  /** start sessionUuid as a fork (copy) of this existing conversation */
  forkFrom?: string;
  skipPermissions: boolean;
  mcpConfigPath?: string;
  settingsPath?: string;
}): string {
  const parts = ["claude"];
  if (opts.forkFrom) {
    parts.push(`--resume ${opts.forkFrom} --fork-session --session-id ${opts.sessionUuid}`);
  } else {
    parts.push(opts.isNew ? `--session-id ${opts.sessionUuid}` : `--resume ${opts.sessionUuid}`);
  }
  if (opts.skipPermissions) parts.push("--dangerously-skip-permissions");
  if (opts.mcpConfigPath) parts.push(`--mcp-config ${quotePath(opts.mcpConfigPath)}`);
  if (opts.settingsPath) parts.push(`--settings ${quotePath(opts.settingsPath)}`);
  return parts.join(" ");
}

const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The status line Claude Code would run in `dir` without Agentyard: our --settings replaces it, so
 * Agentyard's script hands the JSON on to it. Claude's order: the project's settings.local.json,
 * the project's settings.json, then the user's. Unreadable files, non-command status lines and
 * Agentyard's own script are skipped.
 */
export function findUserStatusLine(dir: string, home: string, ownScript: string): {command: string; padding?: number} | undefined {
  const files = [
    path.join(dir, ".claude", "settings.local.json"),
    path.join(dir, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.json"),
  ];
  for (const file of files) {
    let settings: unknown;
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const line = isRecord(settings) ? settings.statusLine : undefined;
    if (!isRecord(line) || line.type !== "command" || typeof line.command !== "string") continue;
    const command = line.command.trim();
    if (!command || command.includes(ownScript)) continue;
    return typeof line.padding === "number" ? {command, padding: line.padding} : {command};
  }
  return undefined;
}
