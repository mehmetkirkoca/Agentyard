import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildGeminiCommand, findGeminiChatDir, geminiSessionExists, isGeminiVoiceModeEnabled, parseGeminiChat, readGeminiPromptsAndModel, stripJsonComments } from "./gemini-launch";

const line = (o: object) => JSON.stringify(o);

describe("buildGeminiCommand", () => {
  it("defaults to plain gemini command", () => {
    expect(buildGeminiCommand()).toBe("gemini");
    expect(buildGeminiCommand({})).toBe("gemini");
  });

  it("uses --approval-mode=yolo, not the deprecated -y, when skipPermissions is true", () => {
    expect(buildGeminiCommand({ skipPermissions: true })).toBe("gemini --approval-mode=yolo");
  });

  it("adds no approval mode when skipPermissions is false", () => {
    expect(buildGeminiCommand({ skipPermissions: false })).toBe("gemini");
  });

  it("adds -m when model is specified", () => {
    expect(buildGeminiCommand({ model: "flash" })).toBe("gemini -m flash");
  });

  it("combines flags correctly", () => {
    expect(buildGeminiCommand({ skipPermissions: true, model: "pro" })).toBe("gemini --approval-mode=yolo -m pro");
  });

  it("uses --session-id when isNew is true", () => {
    expect(buildGeminiCommand({ sessionUuid: "uuid-1234", isNew: true, skipPermissions: true })).toBe(
      "gemini --session-id uuid-1234 --approval-mode=yolo"
    );
  });

  it("uses --session-id if chat file does not exist yet", () => {
    expect(buildGeminiCommand({ sessionUuid: "uuid-1234", isNew: false, targetDir: "/nonexistent" })).toBe(
      "gemini --session-id uuid-1234"
    );
  });
});

describe("with a fake ~/.gemini", () => {
  let tmpHome: string;
  const projectDir = "/workspace/my-app";

  // A project folder as Gemini CLI lays it out; returns its chats dir
  const makeProject = (folder: string, root: string): string => {
    const projTmp = path.join(tmpHome, ".gemini", "tmp", folder);
    fs.mkdirSync(path.join(projTmp, "chats"), { recursive: true });
    fs.writeFileSync(path.join(projTmp, ".project_root"), root);
    return path.join(projTmp, "chats");
  };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-home-"));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("findGeminiChatDir", () => {
    it("follows projects.json to the slug folder", () => {
      makeProject("other", "/workspace/other");
      const chats = makeProject("my-app", projectDir);
      fs.writeFileSync(path.join(tmpHome, ".gemini", "projects.json"), line({ projects: { [projectDir]: "my-app" } }));
      expect(findGeminiChatDir(projectDir, tmpHome)).toBe(chats);
    });

    it("falls back to scanning .project_root files (hash folders)", () => {
      const chats = makeProject("0c5016213e61", projectDir);
      expect(findGeminiChatDir(projectDir, tmpHome)).toBe(chats);
    });

    it("returns undefined when no folder belongs to the directory", () => {
      makeProject("other", "/workspace/other");
      expect(findGeminiChatDir(projectDir, tmpHome)).toBeUndefined();
    });
  });

  describe("geminiSessionExists", () => {
    it("matches the file by the session id's first 8 characters", () => {
      const chats = makeProject("my-app", projectDir);
      fs.writeFileSync(path.join(chats, "session-2026-11-01T10-44-aaaaaaaa.jsonl"), "");
      expect(geminiSessionExists(projectDir, "aaaaaaaa-1111-4222-8333-444444444444", tmpHome)).toBe(true);
      expect(geminiSessionExists(projectDir, "bbbbbbbb-1111-4222-8333-444444444444", tmpHome)).toBe(false);
    });
  });

  describe("readGeminiPromptsAndModel", () => {
    it("reads prompts and model from a .json chat", () => {
      const chats = makeProject("proj1", projectDir);
      fs.writeFileSync(path.join(chats, "session-2026-01-01T00-00-s1s1s1s1.json"), line({
        sessionId: "s1",
        messages: [
          { id: "1", type: "user", content: [{ text: "first question" }] },
          { id: "2", type: "gemini", model: "gemini-2.5-pro", content: "answer" },
          { id: "3", type: "user", content: "second question" },
        ],
      }));
      const result = readGeminiPromptsAndModel(projectDir, tmpHome);
      expect(result.prompts).toEqual(["first question", "second question"]);
      expect(result.model).toBe("gemini-2.5-pro");
    });

    it("reads only the given session's chat, never another session's", () => {
      const chats = makeProject("proj1", projectDir);
      fs.writeFileSync(path.join(chats, "session-2026-01-01T00-00-aaaaaaaa.jsonl"),
        line({ id: "1", type: "user", content: [{ text: "from a" }] }) + "\n");
      fs.writeFileSync(path.join(chats, "session-2026-01-02T00-00-bbbbbbbb.jsonl"),
        line({ id: "1", type: "user", content: [{ text: "from b" }] }) + "\n");
      expect(readGeminiPromptsAndModel(projectDir, tmpHome, "aaaaaaaa-0000").prompts).toEqual(["from a"]);
      expect(readGeminiPromptsAndModel(projectDir, tmpHome, "cccccccc-0000").prompts).toEqual([]);
    });

    it("returns empty when no chats exist", () => {
      const result = readGeminiPromptsAndModel("/non/existent", tmpHome);
      expect(result.prompts).toEqual([]);
      expect(result.model).toBeUndefined();
    });
  });
});

describe("parseGeminiChat", () => {
  it("skips metadata, $set and the injected <session_context> message", () => {
    const raw = [
      line({ sessionId: "s2", startTime: "2026-11-01T00:00:00Z", kind: "main" }),
      line({ id: "c", type: "user", content: [{ text: "<session_context>\nProject instructions...\n</session_context>" }] }),
      line({ $set: { lastUpdated: "2026-11-01T00:00:01Z" } }),
      line({ id: "u1", type: "user", content: [{ text: "how do I add tests?" }] }),
      line({ id: "g1", type: "gemini", model: "gemini-3.5-flash", content: "You can use jest" }),
      line({ id: "i1", type: "info", content: "Request cancelled." }),
      line({ id: "u2", type: "user", content: [{ text: "explain more" }] }),
    ].join("\n") + "\n";
    expect(parseGeminiChat(raw, true)).toEqual({ prompts: ["how do I add tests?", "explain more"], model: "gemini-3.5-flash" });
  });

  it("skips the note Gemini adds when the user leaves plan mode, and tool results", () => {
    const raw = [
      line({ id: "p", type: "user", content: [{ text: "User has manually exited Plan Mode. Switching to Default mode (edits will require confirmation)." }] }),
      line({ id: "u1", type: "user", content: [{ text: "touch a.txt" }] }),
      line({ id: "t1", type: "user", content: [{ functionResponse: { id: "x", name: "run_shell_command", response: {} } }] }),
    ].join("\n");
    expect(parseGeminiChat(raw, true).prompts).toEqual(["touch a.txt"]);
  });

  it("keeps the last record of a repeated message id once", () => {
    const raw = [
      line({ id: "u1", type: "user", content: [{ text: "hello" }] }),
      line({ id: "g1", type: "gemini", model: "gemini-2.5-pro", content: "" }),
      line({ id: "g1", type: "gemini", model: "gemini-3.5-flash", content: "done" }),
      line({ id: "u1", type: "user", content: [{ text: "hello" }] }),
    ].join("\n");
    expect(parseGeminiChat(raw, true)).toEqual({ prompts: ["hello"], model: "gemini-3.5-flash" });
  });

  it("drops the rewound message and everything after it", () => {
    const raw = [
      line({ id: "u1", type: "user", content: [{ text: "keep" }] }),
      line({ id: "u2", type: "user", content: [{ text: "rewound" }] }),
      line({ id: "u3", type: "user", content: [{ text: "also gone" }] }),
      line({ $rewindTo: "u2" }),
      line({ id: "u4", type: "user", content: [{ text: "after rewind" }] }),
    ].join("\n");
    expect(parseGeminiChat(raw, true).prompts).toEqual(["keep", "after rewind"]);
  });

  it("prefers the displayed text over content with expanded @file references", () => {
    const raw = line({
      id: "u1", type: "user",
      content: [{ text: "explain @a.ts" }, { text: "--- a.ts ---\nconst a = 1;" }],
      displayContent: [{ text: "explain @a.ts" }],
    });
    expect(parseGeminiChat(raw, true).prompts).toEqual(["explain @a.ts"]);
  });

  it("ignores a half-written last line", () => {
    const raw = line({ id: "u1", type: "user", content: "ok" }) + "\n{\"id\":\"u2\",\"ty";
    expect(parseGeminiChat(raw, true).prompts).toEqual(["ok"]);
  });
});

describe("isGeminiVoiceModeEnabled", () => {
  let home: string;
  let workspace: string;
  const writeSettings = (root: string, text: string) => {
    fs.mkdirSync(path.join(root, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gemini", "settings.json"), text);
  };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-voice-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-voice-ws-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("is off by default, as in Gemini CLI", () => {
    expect(isGeminiVoiceModeEnabled(home, workspace)).toBe(false);
    writeSettings(home, line({ security: { auth: { selectedType: "gemini-api-key" } } }));
    expect(isGeminiVoiceModeEnabled(home, workspace)).toBe(false);
  });

  it("reads experimental.voiceMode from settings with comments", () => {
    writeSettings(home, '{\n  // voice\n  "experimental": { "voiceMode": true /* on */ },\n  "url": "http://x//y"\n}');
    expect(isGeminiVoiceModeEnabled(home, workspace)).toBe(true);
  });

  it("lets the workspace setting override the user setting", () => {
    writeSettings(home, line({ experimental: { voiceMode: true } }));
    writeSettings(workspace, line({ experimental: { voiceMode: false } }));
    expect(isGeminiVoiceModeEnabled(home, workspace)).toBe(false);
  });
});

describe("stripJsonComments", () => {
  it("keeps comment-like text inside strings", () => {
    expect(JSON.parse(stripJsonComments('{"a": "x // y /* z */", // c\n "b": 1 /* d */}'))).toEqual({ a: "x // y /* z */", b: 1 });
  });
});
