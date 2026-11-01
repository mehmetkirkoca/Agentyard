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

export function buildHookSettings(statusFile: string): object {
  const command = buildHookCommand(statusFile);
  const hooks = [{type: "command", command}];
  return {
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
  if (opts.mcpConfigPath) parts.push(`--mcp-config ${opts.mcpConfigPath}`);
  if (opts.settingsPath) parts.push(`--settings ${opts.settingsPath}`);
  return parts.join(" ");
}
