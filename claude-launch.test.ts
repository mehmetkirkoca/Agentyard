import {execFileSync} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {buildClaudeCommand, buildHookCommand, buildHookSettings, buildPtyEnv, INHERITED_CLAUDE_ENV_KEYS} from "./claude-launch";
import {parseHookEvents} from "./session-status";

describe("buildPtyEnv", () => {
  it("strips nested-session vars and sets AGENTYARD_SESSION_ID", () => {
    const base: NodeJS.ProcessEnv = {PATH: "/bin"};
    for (const key of INHERITED_CLAUDE_ENV_KEYS) base[key] = "1";
    const env = buildPtyEnv(base, "s1");
    for (const key of INHERITED_CLAUDE_ENV_KEYS) expect(env[key]).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.AGENTYARD_SESSION_ID).toBe("s1");
  });

  it("keeps user CLAUDE_CODE_ vars", () => {
    const env = buildPtyEnv({CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "x", CLAUDECODE: "1"}, "s1");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.ANTHROPIC_API_KEY).toBe("x");
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("does not mutate input", () => {
    const base: NodeJS.ProcessEnv = {CLAUDECODE: "1", A: "b"};
    buildPtyEnv(base, "s1");
    expect(base).toEqual({CLAUDECODE: "1", A: "b"});
  });
});

describe("buildClaudeCommand", () => {
  it("forks an existing conversation into a new session id", () => {
    expect(buildClaudeCommand({sessionUuid: "b", isNew: true, forkFrom: "a", skipPermissions: false, settingsPath: "/s.json"}))
      .toBe("claude --resume a --fork-session --session-id b --settings /s.json");
  });

  it("resume with settings", () => {
    expect(buildClaudeCommand({sessionUuid: "u", isNew: false, skipPermissions: false, settingsPath: "/s.json"}))
      .toBe("claude --resume u --settings /s.json");
  });

  it("new with all flags", () => {
    expect(buildClaudeCommand({
      sessionUuid: "u", isNew: true, skipPermissions: true, mcpConfigPath: "/m.json", settingsPath: "/s.json",
    })).toBe("claude --session-id u --dangerously-skip-permissions --mcp-config /m.json --settings /s.json");
  });
});

describe("buildHookSettings", () => {
  it("writes to given status file for all four events", () => {
    const settings = buildHookSettings("/st/u.jsonl") as any;
    const cmd = buildHookCommand("/st/u.jsonl");
    expect(cmd).toContain(">> '/st/u.jsonl'");
    expect(Object.keys(settings.hooks).sort()).toEqual(["Notification", "PostToolUse", "Stop", "UserPromptSubmit"]);
    for (const event of Object.keys(settings.hooks)) {
      expect(settings.hooks[event][0].hooks).toEqual([{type: "command", command: cmd}]);
    }
    expect(settings.hooks.PostToolUse[0].matcher).toBe("*");
  });
});

describe("buildHookCommand", () => {
  let dir: string;
  let statusFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-cmd-"));
    statusFile = path.join(dir, "u.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  const run = (payload: string) => execFileSync("sh", ["-c", buildHookCommand(statusFile)], {input: payload});

  it("appends exactly one JSON line per event with only the status fields", () => {
    run(JSON.stringify({
      session_id: "abc", transcript_path: "/secret/t.jsonl", cwd: "/w", hook_event_name: "PostToolUse",
      tool_name: "Bash", tool_input: {command: "echo \"session_id\": \"x\""}, tool_response: {stdout: "token=hunter2"},
    }));
    run(JSON.stringify({session_id: "abc", hook_event_name: "Notification", message: "Needs permission", notification_type: "permission_prompt"}));
    run(JSON.stringify({session_id: "abc", hook_event_name: "Stop", stop_hook_active: false}));

    const text = fs.readFileSync(statusFile, "utf8");
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(lines.slice(0, 3).map(l => JSON.parse(l))).toEqual([
      {session_id: "abc", hook_event_name: "PostToolUse"},
      {session_id: "abc", hook_event_name: "Notification", notification_type: "permission_prompt"},
      {session_id: "abc", hook_event_name: "Stop"},
    ]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("/secret");
    expect(parseHookEvents(text).map(e => e.hook_event_name)).toEqual(["PostToolUse", "Notification", "Stop"]);
  });

  it("writes an ignorable line for a payload without the fields", () => {
    run("not json");
    expect(fs.readFileSync(statusFile, "utf8")).toBe("{}\n");
    expect(parseHookEvents("{}\n")).toEqual([]);
  });
});
