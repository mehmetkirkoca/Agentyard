import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  TranscriptMeta,
  applyTranscriptLines,
  readTranscriptMeta,
  resolveSessionTitle,
} from "./transcript-meta";

const empty = (): TranscriptMeta => ({ uuid: "u", size: 0, mtimeMs: 0 });

describe("applyTranscriptLines", () => {
  it("custom-title overrides ai-title", () => {
    const meta = applyTranscriptLines(empty(), [
      JSON.stringify({ type: "custom-title", customTitle: "Mine" }),
      JSON.stringify({ type: "ai-title", aiTitle: "Auto" }),
    ]);
    expect(meta.customTitle).toBe("Mine");
    expect(meta.aiTitle).toBe("Auto");
    expect(resolveSessionTitle(meta)).toBe("Mine");
  });

  it("last ai-title wins", () => {
    const meta = applyTranscriptLines(empty(), [
      JSON.stringify({ type: "ai-title", aiTitle: "First" }),
      "not json",
      JSON.stringify({ type: "ai-title", aiTitle: "Second" }),
    ]);
    expect(meta.aiTitle).toBe("Second");
  });

  it("firstPrompt skips tool_result and <command> messages", () => {
    const meta = applyTranscriptLines(empty(), [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Gerçek istek" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Second" } }),
    ]);
    expect(meta.firstPrompt).toBe("Gerçek istek");
  });
});

describe("readTranscriptMeta", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-meta-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores partial trailing line and picks it up next read", () => {
    const file = path.join(dir, "abc.jsonl");
    const first = '{"type":"ai-title","aiTitle":"A"}\n';
    fs.writeFileSync(file, first + '{"type":"ai-ti');
    const m1 = readTranscriptMeta(file);
    expect(m1.uuid).toBe("abc");
    expect(m1.aiTitle).toBe("A");
    expect(m1.size).toBe(Buffer.byteLength(first));
    fs.appendFileSync(file, 'tle","aiTitle":"B"}\n');
    const m2 = readTranscriptMeta(file, m1);
    expect(m2.aiTitle).toBe("B");
  });

  it("keeps byte offsets accurate with multibyte characters", () => {
    const file = path.join(dir, "tr.jsonl");
    const l1 = '{"type":"ai-title","aiTitle":"Release check yavaşlığı"}\n';
    fs.writeFileSync(file, l1);
    const m1 = readTranscriptMeta(file);
    expect(m1.size).toBe(Buffer.byteLength(l1));
    fs.appendFileSync(file, '{"type":"ai-title","aiTitle":"Şğü"}\n');
    expect(readTranscriptMeta(file, m1).aiTitle).toBe("Şğü");
  });

  it("rescans when file shrinks", () => {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, '{"type":"ai-title","aiTitle":"Long old title here"}\n');
    const m1 = readTranscriptMeta(file);
    fs.writeFileSync(file, '{"type":"ai-title","aiTitle":"N"}\n');
    const m2 = readTranscriptMeta(file, m1);
    expect(m2.aiTitle).toBe("N");
  });

  it("reads through symlink", () => {
    const real = path.join(dir, "real.jsonl");
    const link = path.join(dir, "link.jsonl");
    fs.writeFileSync(real, '{"type":"custom-title","customTitle":"Linked"}\n');
    fs.symlinkSync(real, link);
    const m = readTranscriptMeta(link);
    expect(m.customTitle).toBe("Linked");
    expect(m.uuid).toBe("link");
  });

  it("includes file path in errors", () => {
    const missing = path.join(dir, "missing.jsonl");
    expect(() => readTranscriptMeta(missing)).toThrow(missing);
  });
});

describe("resolveSessionTitle", () => {
  it("truncates to 60 chars and collapses to one line", () => {
    const meta = { ...empty(), firstPrompt: "a\nb " + "x".repeat(100) };
    const title = resolveSessionTitle(meta)!;
    expect(title.length).toBe(60);
    expect(title).not.toMatch(/\n/);
  });

  it("returns undefined when nothing is known", () => {
    expect(resolveSessionTitle(empty())).toBeUndefined();
  });
});
