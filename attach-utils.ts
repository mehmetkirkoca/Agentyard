import * as path from "path";
import {appHome} from "./claude-paths";

// Bracketed paste markers: Claude Code turns pasted image paths into [Image #N] attachments
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

// Characters that never need quoting in a path
const SAFE_PATH = /^[A-Za-z0-9_\-.,/:@%+=]+$/;

/**
 * Remove ESC and other control characters, so a file name can never end the paste early
 * or inject terminal input.
 */
export function stripControlChars(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/**
 * Shell-style quoting: plain paths stay as they are, anything else is single-quoted.
 */
export function quotePath(filePath: string): string {
  const clean = stripControlChars(filePath);
  if (SAFE_PATH.test(clean)) return clean;
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

/**
 * The text written to the PTY for attached files: one bracketed paste, paths separated
 * by spaces, a leading and a trailing space, and no Enter. Returns "" when no path is left.
 */
export function buildPathPaste(paths: string[]): string {
  const quoted = paths.map(quotePath).filter(p => p !== "" && p !== "''");
  if (quoted.length === 0) return "";
  return `${PASTE_START} ${quoted.join(" ")} ${PASTE_END}`;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * Clipboard image file name: <YYYYMMDD-HHMMSS>-<n>.png in local time
 */
export function attachmentFileName(date: Date, n: number): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}-${n}.png`;
}

/**
 * Per-session attachment folder: <home>/.agentyard/attachments/<sessionUuid>.
 * The uuid is reduced to safe characters so it cannot escape the folder.
 */
export function attachmentsDir(sessionUuid: string, home?: string): string {
  const safeUuid = sessionUuid.replace(/[^A-Za-z0-9-]/g, "");
  if (!safeUuid) throw new Error(`Invalid session uuid for attachments: ${JSON.stringify(sessionUuid)}`);
  return path.join(appHome(home), "attachments", safeUuid);
}
