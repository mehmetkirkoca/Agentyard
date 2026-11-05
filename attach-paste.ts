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

/**
 * A prompt text as one bracketed paste with no Enter, so it lands in the input box unsent.
 * Control characters other than newlines and tabs are removed, so the text cannot end the paste.
 * Returns "" for blank text.
 */
export function buildTextPaste(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  return clean.trim() ? `${PASTE_START}${clean}${PASTE_END}` : "";
}

// POSIX single-quoting for a value that goes into a shell command line
export const shellQuote = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;
