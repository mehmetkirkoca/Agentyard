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

// Moving a terminal to another parent resets its viewport's DOM scroll position to 0 while xterm
// keeps its own line, and the next scroll event would then jump to the top. A scroll there and back
// makes xterm write the position again (checked in Electron: scrolled up, bottom, top, new output).
export function resyncViewport(term: {buffer: {active: {viewportY: number}}; scrollLines(amount: number): void}): void {
  if (term.buffer.active.viewportY === 0) return;
  term.scrollLines(-1);
  term.scrollLines(1);
}
