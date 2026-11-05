import * as os from "os";
import * as path from "path";
import {standaloneScratchDir} from "./project-model";
export * from "./attach-paste";

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
 * Per-session attachment folder: <home>/agentyard-scratch/attachments/<sessionUuid>.
 * The uuid is reduced to safe characters so it cannot escape the folder.
 *
 * Stored under ~/agentyard-scratch/ (instead of ~/.agentyard/) because on Linux,
 * Snap-confined tools (such as Antigravity CLI / agy installed via snap) are
 * blocked by Snap AppArmor confinement from reading dot-directories like ~/.agentyard.
 */
export function attachmentsDir(sessionUuid: string, home: string = os.homedir()): string {
  const safeUuid = sessionUuid.replace(/[^A-Za-z0-9-]/g, "");
  if (!safeUuid) throw new Error(`Invalid session uuid for attachments: ${JSON.stringify(sessionUuid)}`);
  return path.join(standaloneScratchDir(home), "attachments", safeUuid);
}
