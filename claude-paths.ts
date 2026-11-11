import * as os from "os";
import * as path from "path";

/**
 * Encode a directory path the way Claude Code names its project folders:
 * every non-alphanumeric character becomes a dash.
 */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Claude Code's per-project folder: <home>/.claude/projects/<encoded dir>
 */
export function claudeProjectFolder(dir: string, home: string = os.homedir()): string {
  return path.join(home, ".claude", "projects", encodeProjectDir(dir));
}

/**
 * Agentyard's own data folder: <home>/.agentyard
 */
export function appHome(home: string = os.homedir()): string {
  return path.join(home, ".agentyard");
}

/**
 * Central session store: <home>/.agentyard/sessions
 */
export function centralSessionsDir(home: string = os.homedir()): string {
  return path.join(appHome(home), "sessions");
}

/**
 * Per-session status file: <home>/.agentyard/status/<uuid>.jsonl
 */
export function statusFilePath(sessionUuid: string, home: string = os.homedir()): string {
  return path.join(appHome(home), "status", `${sessionUuid}.jsonl`);
}

/**
 * Per-session hook settings file: <home>/.agentyard/hooks/<uuid>.json
 */
export function hookSettingsPath(sessionUuid: string, home: string = os.homedir()): string {
  return path.join(appHome(home), "hooks", `${sessionUuid}.json`);
}

/**
 * Usage limits as the AI tools last reported them: <home>/.agentyard/limits/<tool>.json
 */
export function limitsDir(home: string = os.homedir()): string {
  return path.join(appHome(home), "limits");
}

/**
 * Claude Code's status line script, which keeps its usage limits: <home>/.agentyard/statusline.sh
 */
export function statusLineScriptPath(home: string = os.homedir()): string {
  return path.join(appHome(home), "statusline.sh");
}

/**
 * The user's own status line command for one session, run by the script after it:
 * <home>/.agentyard/statusline-next/<uuid>
 */
export function statusLineNextPath(sessionUuid: string, home: string = os.homedir()): string {
  return path.join(appHome(home), "statusline-next", sessionUuid);
}
