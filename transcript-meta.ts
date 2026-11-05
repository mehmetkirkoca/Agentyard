import * as fs from "fs";
import * as path from "path";
import {promptText} from "./prompt-history";

export interface TranscriptMeta {
  uuid: string;
  size: number;
  mtimeMs: number;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  lastSummary?: string;
  lastSummaryAt?: number;
}

const MAX_TITLE_LENGTH = 60;
const MAX_PREVIEW_LENGTH = 1000;

/**
 * Fold parsed transcript lines into the metadata. Unparseable lines are skipped.
 */
export function applyTranscriptLines(meta: TranscriptMeta, lines: string[]): TranscriptMeta {
  const next: TranscriptMeta = { ...meta };
  for (const line of lines) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      next.customTitle = entry.customTitle;
    } else if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
      next.aiTitle = entry.aiTitle;
    } else if (entry.type === "user" && next.firstPrompt === undefined) {
      const content = entry.message?.content;
      if (typeof content === "string" && !content.startsWith("<")) {
        next.firstPrompt = content;
      }
    }
    if (entry.type === "system" && entry.subtype === "away_summary" && typeof entry.content === "string") {
      next.lastSummary = entry.content.slice(0, MAX_PREVIEW_LENGTH);
      const at = Date.parse(entry.timestamp);
      next.lastSummaryAt = Number.isNaN(at) ? undefined : at;
    } else if (!entry.isCompactSummary && !entry.isSidechain) {
      const prompt = promptText(entry);
      if (prompt) next.lastPrompt = prompt.slice(0, MAX_PREVIEW_LENGTH);
    }
  }
  return next;
}

function withPath<T>(filePath: string, op: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new Error(`${op} failed for ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Read transcript metadata, continuing from prev.size when the file only grew.
 * Only complete lines (up to the last newline) are consumed; size is the
 * consumed byte offset. Follows symlinks.
 */
export function readTranscriptMeta(filePath: string, prev?: TranscriptMeta): TranscriptMeta {
  const uuid = path.basename(filePath, ".jsonl");
  const stat = withPath(filePath, "stat", () => fs.statSync(filePath));
  const resumable = prev !== undefined && prev.size <= stat.size;
  const base: TranscriptMeta = resumable
    ? { ...prev!, uuid, mtimeMs: stat.mtimeMs }
    : { uuid, size: 0, mtimeMs: stat.mtimeMs };
  const offset = base.size;
  const length = stat.size - offset;
  if (length <= 0) return base;

  const buf = Buffer.alloc(length);
  const bytesRead = withPath(filePath, "read", () => {
    const fd = fs.openSync(filePath, "r");
    try {
      let total = 0;
      while (total < length) {
        const n = fs.readSync(fd, buf, total, length - total, offset + total);
        if (n === 0) break;
        total += n;
      }
      return total;
    } finally {
      fs.closeSync(fd);
    }
  });

  const lastNewline = buf.lastIndexOf(0x0a, bytesRead - 1);
  if (lastNewline < 0) return base;
  const consumed = lastNewline + 1;
  const lines = buf.toString("utf8", 0, consumed).split("\n");
  return { ...applyTranscriptLines(base, lines), size: offset + consumed };
}

/**
 * Title priority: customTitle > aiTitle > firstPrompt, single line, max 60 chars.
 */
export function resolveSessionTitle(meta: TranscriptMeta): string | undefined {
  const raw = meta.customTitle || meta.aiTitle || meta.firstPrompt;
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine ? oneLine.slice(0, MAX_TITLE_LENGTH) : undefined;
}
