import * as fs from "fs";

/**
 * The user's own prompts in a transcript, in order, with the uuid of each prompt's entry (a fork
 * starts right before one); size is the consumed byte offset.
 */
export interface PromptHistory {
  size: number;
  prompts: string[];
  uuids: string[];
}

/** Text the user typed, or undefined for tool results, meta entries and system-injected messages. */
export function promptText(entry: any): string | undefined {
  if (entry?.type !== "user" || entry.isMeta) return undefined;
  const content = entry.message?.content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.find((part: any) => part?.type === "text" && typeof part.text === "string")?.text;
  }
  const trimmed = text?.trim();
  // "<command-name>", "<task-notification>", "<pasted_content>" ... and "[Request interrupted by user]"
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("[Request interrupted")) return undefined;
  return trimmed;
}

/** Fold parsed transcript lines into the history. Unparseable lines are skipped. */
export function applyPromptLines(history: PromptHistory, lines: string[]): PromptHistory {
  const prompts = [...history.prompts];
  const uuids = [...history.uuids];
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      const text = promptText(entry);
      if (text) {
        prompts.push(text);
        uuids.push(typeof entry.uuid === "string" ? entry.uuid : "");
      }
    } catch {
      // skip unparseable line
    }
  }
  return {...history, prompts, uuids};
}

/**
 * Read the user's prompts from a transcript, continuing from prev.size when the file only grew.
 * Only complete lines (up to the last newline) are consumed. Errors name the file.
 */
export function readUserPrompts(filePath: string, prev?: PromptHistory): PromptHistory {
  try {
    const size = fs.statSync(filePath).size;
    const base: PromptHistory = prev && prev.size <= size ? prev : {size: 0, prompts: [], uuids: []};
    const length = size - base.size;
    if (length <= 0) return base;

    const buf = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    let bytesRead = 0;
    try {
      while (bytesRead < length) {
        const n = fs.readSync(fd, buf, bytesRead, length - bytesRead, base.size + bytesRead);
        if (n === 0) break;
        bytesRead += n;
      }
    } finally {
      fs.closeSync(fd);
    }

    const lastNewline = buf.lastIndexOf(0x0a, bytesRead - 1);
    if (lastNewline < 0) return base;
    const consumed = lastNewline + 1;
    const lines = buf.toString("utf8", 0, consumed).split("\n");
    return {...applyPromptLines(base, lines), size: base.size + consumed};
  } catch (err) {
    throw new Error(`Reading prompts failed for ${filePath}: ${(err as Error).message}`);
  }
}
