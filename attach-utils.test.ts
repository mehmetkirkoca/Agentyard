import {
  attachmentFileName,
  attachmentsDir,
  buildPathPaste,
  buildTextPaste,
  PASTE_END,
  PASTE_START,
  quotePath,
  stripControlChars,
} from "./attach-utils";

describe("stripControlChars", () => {
  it("removes ESC, other C0 characters and DEL", () => {
    expect(stripControlChars("/a/b\x1b[201~c\r\n\t\x00\x7f.png")).toBe("/a/b[201~c.png");
  });

  it("keeps ordinary and non-ASCII characters", () => {
    expect(stripControlChars("/home/x/Görsel Ş.png")).toBe("/home/x/Görsel Ş.png");
  });
});

describe("quotePath", () => {
  it("leaves plain paths unquoted", () => {
    expect(quotePath("/tmp/a-b_c/1.0/img.png")).toBe("/tmp/a-b_c/1.0/img.png");
  });

  it("single-quotes paths with spaces or special characters", () => {
    expect(quotePath("/tmp/dir with space/g.png")).toBe("'/tmp/dir with space/g.png'");
    expect(quotePath("/tmp/a$b(c).png")).toBe("'/tmp/a$b(c).png'");
    expect(quotePath("/tmp/Görsel.png")).toBe("'/tmp/Görsel.png'");
  });

  it("escapes single quotes inside a quoted path", () => {
    expect(quotePath("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
  });

  it("strips control characters before quoting", () => {
    expect(quotePath("/tmp/a\x1b[201~b.png")).toBe("'/tmp/a[201~b.png'");
  });

  it("also strips C1 control characters (e.g. single-byte CSI) but keeps other Unicode", () => {
    expect(stripControlChars("/tmp/a\u009b201~b\u0085ğüş.png")).toBe("/tmp/a201~bğüş.png");
  });
});

describe("buildPathPaste", () => {
  it("wraps space-separated paths in one bracketed paste with leading and trailing space, no Enter", () => {
    const text = buildPathPaste(["/tmp/a.png", "/tmp/dir x/b.pdf"]);
    expect(text).toBe(`${PASTE_START} /tmp/a.png '/tmp/dir x/b.pdf' ${PASTE_END}`);
    expect(text).not.toMatch(/[\r\n]/);
  });

  it("cannot be ended early by a file name", () => {
    const text = buildPathPaste(["/tmp/evil\x1b[201~\r.png"]);
    expect(text.indexOf(PASTE_END)).toBe(text.length - PASTE_END.length);
  });

  it("returns an empty string when there is nothing to insert", () => {
    expect(buildPathPaste([])).toBe("");
    expect(buildPathPaste(["\x1b\r"])).toBe("");
  });
});

describe("buildTextPaste", () => {
  it("wraps the text in one bracketed paste, keeping newlines and tabs", () => {
    expect(buildTextPaste("soru\r\n\tdevam")).toBe(`${PASTE_START}soru\n\tdevam${PASTE_END}`);
  });

  it("removes control characters that could end the paste early", () => {
    expect(buildTextPaste(`a${PASTE_END}b`)).toBe(`${PASTE_START}a[201~b${PASTE_END}`);
  });

  it("is empty for blank text", () => {
    expect(buildTextPaste("  \n ")).toBe("");
  });
});

describe("attachmentFileName", () => {
  it("formats local time as YYYYMMDD-HHMMSS-n.png", () => {
    expect(attachmentFileName(new Date(2026, 9, 3, 7, 5, 9), 2)).toBe("20261003-070509-2.png");
  });
});

describe("attachmentsDir", () => {
  it("points to <home>/.agentyard/attachments/<uuid>", () => {
    expect(attachmentsDir("0a1b-2c3d", "/h")).toBe("/h/.agentyard/attachments/0a1b-2c3d");
  });

  it("drops characters that could escape the folder", () => {
    expect(attachmentsDir("../../etc", "/h")).toBe("/h/.agentyard/attachments/etc");
  });

  it("rejects an empty uuid", () => {
    expect(() => attachmentsDir("../", "/h")).toThrow("Invalid session uuid");
  });
});
