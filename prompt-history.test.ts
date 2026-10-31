import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {applyPromptLines, readUserPrompts, PromptHistory} from "./prompt-history";

const user = (content: unknown, extra: object = {}) =>
  JSON.stringify({type: "user", message: {role: "user", content}, ...extra});

const empty = (): PromptHistory => ({size: 0, prompts: []});

describe("applyPromptLines", () => {
  it("collects string and text-part prompts in order", () => {
    const h = applyPromptLines(empty(), [
      user("Birinci soru"),
      JSON.stringify({type: "assistant", message: {content: "cevap"}}),
      user([{type: "text", text: "İkinci soru"}, {type: "image"}]),
    ]);
    expect(h.prompts).toEqual(["Birinci soru", "İkinci soru"]);
  });

  it("skips tool results, meta entries, system tags, interrupts and broken lines", () => {
    const h = applyPromptLines(empty(), [
      user([{type: "tool_result", content: "x"}]),
      user([{type: "text", text: "[Image: source: /tmp/a.png]"}], {isMeta: true}),
      user("<command-name>/clear</command-name>"),
      user("<task-notification>\n<task-id>x</task-id>"),
      user([{type: "text", text: "\n\n<pasted_content id=\"a\">\nlog\n</pasted_content>"}]),
      user([{type: "text", text: "[Request interrupted by user]"}]),
      user("   "),
      "{broken",
      "",
      user("Gerçek soru"),
    ]);
    expect(h.prompts).toEqual(["Gerçek soru"]);
  });

  it("appends to the previous prompts", () => {
    const h = applyPromptLines({size: 10, prompts: ["eski"]}, [user("yeni")]);
    expect(h.prompts).toEqual(["eski", "yeni"]);
  });
});

describe("readUserPrompts", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-"));
    file = path.join(dir, "t.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it("reads only complete lines and continues from the previous size", () => {
    fs.writeFileSync(file, `${user("bir")}\n${user("iki").slice(0, 10)}`);
    const first = readUserPrompts(file);
    expect(first.prompts).toEqual(["bir"]);
    expect(first.size).toBe(Buffer.byteLength(`${user("bir")}\n`));

    fs.writeFileSync(file, `${user("bir")}\n${user("iki")}\n`);
    const second = readUserPrompts(file, first);
    expect(second.prompts).toEqual(["bir", "iki"]);
  });

  it("starts over when the file shrank", () => {
    fs.writeFileSync(file, `${user("yeni")}\n`);
    const h = readUserPrompts(file, {size: 99999, prompts: ["eski"]});
    expect(h.prompts).toEqual(["yeni"]);
  });

  it("throws with the path when the file is missing", () => {
    expect(() => readUserPrompts(path.join(dir, "yok.jsonl"))).toThrow(/yok\.jsonl/);
  });
});
