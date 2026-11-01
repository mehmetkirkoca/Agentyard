import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildGeminiCommand, findGeminiChatDir, readGeminiPromptsAndModel } from "./gemini-launch";

describe("buildGeminiCommand", () => {
  it("defaults to plain gemini command", () => {
    expect(buildGeminiCommand()).toBe("gemini");
    expect(buildGeminiCommand({})).toBe("gemini");
  });

  it("adds -y when skipPermissions is true", () => {
    expect(buildGeminiCommand({ skipPermissions: true })).toBe("gemini -y");
  });

  it("does not add -y when skipPermissions is false", () => {
    expect(buildGeminiCommand({ skipPermissions: false })).toBe("gemini");
  });

  it("adds -m when model is specified", () => {
    expect(buildGeminiCommand({ model: "gemini-2.5-pro" })).toBe("gemini -m gemini-2.5-pro");
  });

  it("combines flags correctly", () => {
    expect(buildGeminiCommand({ skipPermissions: true, model: "gemini-2.5-flash" })).toBe(
      "gemini -y -m gemini-2.5-flash"
    );
  });

  it("uses --session-id when isNew is true", () => {
    expect(buildGeminiCommand({ sessionUuid: "uuid-1234", isNew: true, skipPermissions: true })).toBe(
      "gemini --session-id uuid-1234 -y"
    );
  });

  it("uses --session-id if chat file does not exist yet", () => {
    expect(buildGeminiCommand({ sessionUuid: "uuid-1234", isNew: false, targetDir: "/nonexistent", skipPermissions: true })).toBe(
      "gemini --session-id uuid-1234 -y"
    );
  });
});

describe("readGeminiPromptsAndModel", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-home-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it("reads prompts and model from gemini tmp chats directory", () => {
    const projectDir = "/workspace/my-app";
    const projTmp = path.join(tmpHome, ".gemini", "tmp", "proj1");
    const chatsDir = path.join(projTmp, "chats");
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(projTmp, ".project_root"), projectDir);

    const chatContent = {
      sessionId: "s1",
      messages: [
        { type: "user", content: [{ text: "first question" }] },
        { type: "gemini", model: "gemini-2.5-pro", content: "answer" },
        { type: "user", content: "second question" },
      ],
    };
    fs.writeFileSync(path.join(chatsDir, "session-123.json"), JSON.stringify(chatContent));

    const result = readGeminiPromptsAndModel(projectDir, tmpHome);
    expect(result.prompts).toEqual(["first question", "second question"]);
    expect(result.model).toBe("gemini-2.5-pro");
  });

  it("reads prompts and model from .jsonl file and filters <session_context>", () => {
    const projectDir = "/workspace/my-app";
    const projTmp = path.join(tmpHome, ".gemini", "tmp", "proj1");
    const chatsDir = path.join(projTmp, "chats");
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(projTmp, ".project_root"), projectDir);

    const jsonlLines = [
      JSON.stringify({ sessionId: "s2", startTime: "2026-11-01T00:00:00Z" }),
      JSON.stringify({ type: "user", content: [{ text: "<session_context>\nProject instructions...\n</session_context>" }] }),
      JSON.stringify({ type: "user", content: [{ text: "how do I add tests?" }] }),
      JSON.stringify({ type: "gemini", model: "gemini-2.5-flash", content: "You can use jest" }),
      JSON.stringify({ type: "info", content: "Request cancelled." }),
      JSON.stringify({ type: "user", content: [{ text: "explain more" }] }),
    ];
    fs.writeFileSync(path.join(chatsDir, "session-2026-11-01.jsonl"), jsonlLines.join("\n") + "\n");

    const result = readGeminiPromptsAndModel(projectDir, tmpHome);
    expect(result.prompts).toEqual(["how do I add tests?", "explain more"]);
    expect(result.model).toBe("gemini-2.5-flash");
  });

  it("returns empty when no chats exist", () => {
    const result = readGeminiPromptsAndModel("/non/existent", tmpHome);
    expect(result.prompts).toEqual([]);
    expect(result.model).toBeUndefined();
  });
});
