import {
  assertNoteContent, assertNoteId, createNote, deleteNote, MAX_NOTE_LENGTH, Note, noteTitle,
  parseStoredNotes, sortNotes, UNTITLED_NOTE, updateNote,
} from "./notes-model";

const note = (id: string, updatedAt: number, content = ""): Note => ({id, content, updatedAt});

describe("noteTitle", () => {
  it("uses the first non-blank line, trimmed", () => {
    expect(noteTitle("\n   \n  Alışveriş listesi  \nsüt")).toBe("Alışveriş listesi");
  });

  it("falls back for an empty or blank note", () => {
    expect(noteTitle("")).toBe(UNTITLED_NOTE);
    expect(noteTitle("  \n\t\n")).toBe(UNTITLED_NOTE);
  });
});

describe("sortNotes", () => {
  it("puts the most recently edited first without mutating the input", () => {
    const input = [note("a", 1), note("b", 3), note("c", 2)];
    expect(sortNotes(input).map(n => n.id)).toEqual(["b", "c", "a"]);
    expect(input.map(n => n.id)).toEqual(["a", "b", "c"]);
  });
});

describe("parseStoredNotes", () => {
  it("returns an empty list for a missing or non-array value", () => {
    expect(parseStoredNotes(undefined)).toEqual([]);
    expect(parseStoredNotes({id: "a"})).toEqual([]);
  });

  it("drops malformed entries and extra fields", () => {
    const raw = [
      {id: "a", content: "x", updatedAt: 1, extra: true},
      {id: "", content: "x", updatedAt: 1},
      {id: "b", content: 5, updatedAt: 1},
      {id: "c", content: "x", updatedAt: NaN},
      null,
    ];
    expect(parseStoredNotes(raw)).toEqual([note("a", 1, "x")]);
  });
});

describe("assertions", () => {
  it("accepts a string up to the limit", () => {
    expect(assertNoteContent("merhaba")).toBe("merhaba");
    expect(() => assertNoteContent("x".repeat(MAX_NOTE_LENGTH + 1))).toThrow("longer");
    expect(() => assertNoteContent(42)).toThrow("string");
  });

  it("requires a non-empty string id", () => {
    expect(assertNoteId("a")).toBe("a");
    expect(() => assertNoteId("")).toThrow();
    expect(() => assertNoteId(undefined)).toThrow();
  });
});

describe("createNote / updateNote / deleteNote", () => {
  it("creates an empty note", () => {
    const {notes, note: created} = createNote([note("a", 1)], "b", 5);
    expect(created).toEqual(note("b", 5));
    expect(notes.map(n => n.id)).toEqual(["a", "b"]);
  });

  it("refuses a duplicate id", () => {
    expect(() => createNote([note("a", 1)], "a", 5)).toThrow("already exists");
  });

  it("updates content and timestamp of one note", () => {
    const input = [note("a", 1, "eski"), note("b", 2)];
    const {notes, note: updated} = updateNote(input, "a", "yeni", 9);
    expect(updated).toEqual(note("a", 9, "yeni"));
    expect(notes).toEqual([note("a", 9, "yeni"), note("b", 2)]);
    expect(input[0].content).toBe("eski");
  });

  it("fails to update an unknown note", () => {
    expect(() => updateNote([], "x", "y", 1)).toThrow("not found");
  });

  it("deletes by id and ignores an unknown id", () => {
    expect(deleteNote([note("a", 1), note("b", 2)], "a").map(n => n.id)).toEqual(["b"]);
    expect(deleteNote([note("a", 1)], "x").map(n => n.id)).toEqual(["a"]);
  });
});
