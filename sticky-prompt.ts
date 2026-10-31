/** Claude Code echoes each submitted prompt as "❯ <first line>"; the input box uses the same glyph. */
export const PROMPT_GLYPH = "❯ ";

export interface PromptRow {
  /** screen row of the echoed prompt */
  row: number;
  /** index into the transcript prompts */
  index: number;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Screen rows where Claude Code echoed one of the user's prompts. A glyph row counts only when its
 * text is the start of a known prompt (an exact match wins), so the input box never matches. Rows
 * and prompts are aligned from the bottom, so a repeated prompt maps to its latest occurrence.
 */
export function findPromptRows(lines: string[], prompts: string[]): PromptRow[] {
  const normalized = prompts.map(normalize);
  const result: PromptRow[] = [];
  let cursor = prompts.length - 1;
  for (let row = lines.length - 1; row >= 0 && cursor >= 0; row--) {
    const line = lines[row];
    if (!line.startsWith(PROMPT_GLYPH)) continue;
    const echoed = normalize(line.slice(PROMPT_GLYPH.length));
    if (!echoed) continue;
    let index = -1;
    for (let i = cursor; i >= 0 && index < 0; i--) {
      if (normalized[i] === echoed) index = i;
    }
    for (let i = cursor; i >= 0 && index < 0; i--) {
      if (normalized[i].startsWith(echoed)) index = i;
    }
    if (index < 0) continue;
    result.push({row, index});
    cursor = index - 1;
  }
  return result.reverse();
}

// Fullscreen Claude Code's scrolled-up indicator, centred over a content row above the input box,
// whose text may run on past it: "Jump to bottom" or "N new messages", then " (key) ↓",
// " (click) ↓", " ↓" or ": key to scroll"
const JUMP_TO_BOTTOM_RE = /(?:Jump to bottom|\d+ new messages?)(?: \([^)]*\) ↓| ↓|: \S+ to scroll)/;

/** Whether fullscreen Claude Code's scrolled-up indicator is on screen. */
export function hasJumpToBottom(lines: string[]): boolean {
  return lines.some(line => JUMP_TO_BOTTOM_RE.test(line));
}

// A prompt on one of these top rows is the one being read: the top row is Claude Code's sticky
// header slot, and a scroll to a prompt lands it right under it
const CURRENT_PROMPT_ROWS = 2;

/**
 * Index of the prompt whose answer is at the top of the screen. Not scrolled up: the last prompt.
 * Otherwise the top row belongs to the prompt before the first one on screen (or to that one when
 * it sits on the top rows). With no prompt on screen, the previous answer stands, since
 * scrolling moves prompts across the screen one at a time.
 */
export function currentPromptIndex(
  lines: string[],
  prompts: string[],
  scrolledUp: boolean,
  previous: number | null,
): number | null {
  if (prompts.length === 0) return null;
  if (!scrolledUp) return prompts.length - 1;
  const first = findPromptRows(lines, prompts)[0];
  if (!first) return previous === null ? null : Math.min(previous, prompts.length - 1);
  if (first.row < CURRENT_PROMPT_ROWS) return first.index;
  return first.index > 0 ? first.index - 1 : null;
}

export type SeekStep = "up" | "down" | "done";

/**
 * Next scroll step toward the prompt at `target`, which ends on the top rows. Prompts on screen
 * give the direction; with none, the current prompt does (its own row is above the screen). A
 * target between an earlier and a later prompt is there even when its echo never matches (a paste
 * shown as "[Pasted text #1]"). Scrolling down stops at the bottom. `skipRows` top rows are
 * ignored, like fullscreen Claude Code's sticky header.
 */
export function seekStep(
  lines: string[],
  prompts: string[],
  target: number,
  skipRows: number,
  scrolledUp: boolean,
  current: number | null,
): SeekStep {
  const down: SeekStep = scrolledUp ? "down" : "done";
  const rows = findPromptRows(lines.slice(skipRows), prompts).map(r => ({...r, row: r.row + skipRows}));
  const hit = rows.find(r => r.index === target);
  if (hit) return hit.row < CURRENT_PROMPT_ROWS ? "done" : down;
  const earlier = rows.some(r => r.index < target);
  const later = rows.some(r => r.index > target);
  if (earlier && later) return "done";
  if (earlier) return down;
  if (later) return "up";
  return current !== null && current < target ? down : "up";
}
