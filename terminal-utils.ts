// Terminal escape sequences used for detecting terminal state

// Bracketed paste mode enable - indicates terminal is ready for input
export const BRACKETED_PASTE_MODE_ENABLE = "\x1b[?2004h";

// Pattern that indicates Claude interactive session is done and waiting for input
// Looks for: >\r\n (empty prompt with no space, no suggestion text)
const CLAUDE_READY_PROMPT_PATTERN = />\r\n/;

// Check if a normal shell terminal is ready for input
// Used during terminal initialization in main.ts
export function isTerminalReady(buffer: string, startPos: number = 0): boolean {
  return buffer.includes(BRACKETED_PASTE_MODE_ENABLE, startPos);
}

// Check if Claude interactive session is done and ready for input
// Used for unread indicator detection in renderer.ts
export function isClaudeSessionReady(buffer: string): boolean {
  return CLAUDE_READY_PROMPT_PATTERN.test(buffer);
}

// Copy keys in a terminal (VS Code style): Ctrl+C copies only while text is selected, so without a
// selection it still interrupts the program; Ctrl+Shift+C and Cmd+C copy the selection
export function isCopyKey(
  e: {type: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean},
  hasSelection: boolean,
): boolean {
  if (e.type !== "keydown" || e.code !== "KeyC" || e.altKey || !hasSelection) return false;
  return e.ctrlKey || e.metaKey;
}
