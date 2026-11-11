// Free-form notes opened with Ctrl+Shift+N. Pure list operations, so main.ts only reads and writes
// the store; every function returns a new array and never mutates its input.

export interface Note {
  id: string;
  content: string;
  /** epoch ms of the last edit */
  updatedAt: number;
}

export const UNTITLED_NOTE = "Başlıksız not";
/** Guards the store against a runaway paste; far beyond any hand-written note. */
export const MAX_NOTE_LENGTH = 1_000_000;

/** First non-blank line, trimmed; the list shows it as the note's title. */
export function noteTitle(content: string): string {
  const line = content.split("\n").find(l => l.trim() !== "");
  return line ? line.trim() : UNTITLED_NOTE;
}

/** Most recently edited first. */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
}

function isNote(value: unknown): value is Note {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.id !== "" && typeof v.content === "string"
    && typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt);
}

/** Whatever the store holds (missing, or edited by hand), keeps only well-formed notes. */
export function parseStoredNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isNote).map(n => ({id: n.id, content: n.content, updatedAt: n.updatedAt}));
}

export function assertNoteContent(content: unknown): string {
  if (typeof content !== "string") throw new Error("note content must be a string");
  if (content.length > MAX_NOTE_LENGTH) throw new Error(`note is longer than ${MAX_NOTE_LENGTH} characters`);
  return content;
}

export function assertNoteId(id: unknown): string {
  if (typeof id !== "string" || id === "") throw new Error("note id must be a non-empty string");
  return id;
}

export function createNote(notes: readonly Note[], id: string, now: number): {notes: Note[]; note: Note} {
  if (notes.some(n => n.id === id)) throw new Error(`note already exists: ${id}`);
  const note: Note = {id, content: "", updatedAt: now};
  return {notes: [...notes, note], note};
}

export function updateNote(notes: readonly Note[], id: string, content: string, now: number): {notes: Note[]; note: Note} {
  const existing = notes.find(n => n.id === id);
  if (!existing) throw new Error(`note not found: ${id}`);
  const note: Note = {...existing, content, updatedAt: now};
  return {notes: notes.map(n => (n.id === id ? note : n)), note};
}

export function deleteNote(notes: readonly Note[], id: string): Note[] {
  return notes.filter(n => n.id !== id);
}
