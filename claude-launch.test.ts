import {execFileSync} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {buildClaudeCommand, buildHookCommand, buildHookSettings, buildPtyEnv, buildStatusLineCommand, buildStatusLineScript, claudeScrollEnv, INHERITED_CLAUDE_ENV_KEYS} from "./claude-launch";
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

  it("strips npm_config_prefix so NVM loads properly", () => {
    const env = buildPtyEnv({npm_config_prefix: "/usr/local", NPM_CONFIG_PREFIX: "/usr/local"}, "s1");
    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
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

describe("buildHookSettings: fullscreen", () => {
  it("leaves the user's own tui setting alone by default", () => {
    expect(buildHookSettings("/st/u.jsonl")).not.toHaveProperty("tui");
    expect(buildHookSettings("/st/u.jsonl", {disableFullscreen: false})).not.toHaveProperty("tui");
  });

  it("overrides it with the normal renderer when fullscreen is turned off", () => {
    expect(buildHookSettings("/st/u.jsonl", {disableFullscreen: true})).toMatchObject({tui: "default"});
  });
});

describe("claudeScrollEnv", () => {
  it("sets Claude's wheel speed for a chosen level", () => {
    expect(claudeScrollEnv(3)).toEqual({CLAUDE_CODE_SCROLL_SPEED: "3"});
    expect(claudeScrollEnv(20)).toEqual({CLAUDE_CODE_SCROLL_SPEED: "20"});
  });

  it("sets nothing for Default or a value Claude would not accept", () => {
    for (const level of [0, -1, 21, 1.5, NaN, undefined, "3", null]) expect(claudeScrollEnv(level)).toEqual({});
  });
});

describe("buildClaudeCommand paths", () => {
  it("keeps hostile config paths as literal arguments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentyard-launch-"));
    const canary = path.join(dir, "canary");
    const mcpConfigPath = path.join(dir, `a b$(touch ${canary})`, "m.json");
    const settingsPath = path.join(dir, `c;touch ${canary}`, "s.json");
    try {
      const command = buildClaudeCommand({sessionUuid: "u", isNew: false, skipPermissions: false, mcpConfigPath, settingsPath});
      const argv = execFileSync("bash", ["-c", `claude() { printf '%s\\0' "$@"; }; ${command}`], {encoding: "utf8"})
        .split("\0").slice(0, -1);
      expect(argv).toEqual(["--resume", "u", "--mcp-config", mcpConfigPath, "--settings", settingsPath]);
      expect(fs.existsSync(canary)).toBe(false);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe("status line", () => {
  let dir: string;
  let limitsFile: string;
  let script: string;
  const payload = (withLimits: boolean) => JSON.stringify({
    model: {id: "claude-opus-5-5"},
    ...(withLimits ? {rate_limits: {five_hour: {used_percentage: 42, resets_at: 1794410280}}} : {}),
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "status line '"));
    limitsFile = path.join(dir, "limits dir", "claude.json");
    fs.mkdirSync(path.dirname(limitsFile));
    script = path.join(dir, "statusline.sh");
    fs.writeFileSync(script, buildStatusLineScript(limitsFile));
  });
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const run = (input: string, nextFile?: string) =>
    execFileSync("sh", ["-c", buildStatusLineCommand(script, nextFile)], {input}).toString();

  it("keeps the latest JSON that carries rate_limits and prints nothing on its own", () => {
    expect(run(payload(true))).toBe("");
    expect(JSON.parse(fs.readFileSync(limitsFile, "utf8")).rate_limits.five_hour.used_percentage).toBe(42);
  });

  it("leaves the kept limits alone for a JSON without rate_limits", () => {
    run(payload(true));
    run(payload(false));
    expect(fs.readFileSync(limitsFile, "utf8")).toContain("rate_limits");
    expect(fs.readdirSync(path.dirname(limitsFile))).toEqual(["claude.json"]);
  });

  it("hands the JSON to the user's own status line and prints what it prints", () => {
    const nextFile = path.join(dir, "next");
    fs.writeFileSync(nextFile, `jq -r '.model.id' 2>/dev/null || sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p'`);
    expect(run(payload(true), nextFile).trim()).toBe("claude-opus-5-5");
    expect(fs.existsSync(limitsFile)).toBe(true);
  });

  it("keeps going when the user's status line fails", () => {
    const nextFile = path.join(dir, "next");
    fs.writeFileSync(nextFile, "exit 3");
    expect(() => run(payload(true), nextFile)).not.toThrow();
  });

  it("is passed to Claude through the hook settings, padding kept", () => {
    const settings = buildHookSettings("/st/u.jsonl", {statusLine: {command: "sh /x/statusline.sh", padding: 0}}) as any;
    expect(settings.statusLine).toEqual({type: "command", command: "sh /x/statusline.sh", padding: 0});
    expect((buildHookSettings("/st/u.jsonl") as any).statusLine).toBeUndefined();
  });
});
