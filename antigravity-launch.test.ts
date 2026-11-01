import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {execFileSync} from "child_process";
import {
  adoptAgyConversation,
  agyPromptsOf,
  AGY_STATUS_ENV,
  agyTranscriptPath,
  buildAgyCommand,
  buildAgyHookCommand,
  buildAgyStatusPlugin,
  createAgyWaitingDetector,
  ensureAgyStatusPlugin,
  filterAgyEvents,
  parseAgyTranscript,
  readAgyPrompts,
  resolveAgyBinary,
  writeAgyStatusPlugin,
} from "./antigravity-launch";

describe("resolveAgyBinary", () => {
  it("prefers ~/.gemini/bin/agy when executable", () => {
    expect(resolveAgyBinary("/h", p => p === "/h/.gemini/bin/agy")).toBe("/h/.gemini/bin/agy");
  });

  it("falls back to agy on PATH", () => {
    expect(resolveAgyBinary("/h", () => false)).toBe("agy");
  });
});

describe("buildAgyCommand", () => {
  it("starts plain without a conversation", () => {
    expect(buildAgyCommand({binary: "agy", skipPermissions: false})).toBe("agy");
  });

  it("never types a conversation id that is not a uuid into the shell", () => {
    // the id comes from the status file, which agy's tools could write to
    expect(buildAgyCommand({binary: "agy", conversationId: "x; rm -rf ~", skipPermissions: false})).toBe("agy");
  });

  it("resumes and skips permissions", () => {
    const id = "a071ac23-7cf6-4566-88bb-a9d278961012";
    expect(buildAgyCommand({binary: "/h/.gemini/bin/agy", conversationId: id, skipPermissions: true}))
      .toBe(`'/h/.gemini/bin/agy' --conversation ${id} --dangerously-skip-permissions`);
  });
});

// As agy 1.4.12 writes brain/<id>/.system_generated/logs/transcript_full.jsonl
const userStep = (text: string) => JSON.stringify({
  step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE",
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x\n</ADDITIONAL_METADATA>`,
});

describe("parseAgyTranscript", () => {
  it("returns the text inside USER_REQUEST of USER_INPUT steps", () => {
    const raw = [userStep("first"), JSON.stringify({type: "PLANNER_RESPONSE", content: "ok"}), userStep("second\nline")].join("\n");
    expect(parseAgyTranscript(raw)).toEqual(["first", "second\nline"]);
  });

  it("skips USER_INPUT without a USER_REQUEST wrapper", () => {
    expect(parseAgyTranscript(JSON.stringify({type: "USER_INPUT", content: "system note"}))).toEqual([]);
  });

  it("ignores a half-written last line", () => {
    expect(parseAgyTranscript(userStep("ok") + "\n{\"type\":\"USER_IN")).toEqual(["ok"]);
  });
});

describe("readAgyPrompts", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
  });
  afterEach(() => {
    fs.rmSync(tmpHome, {recursive: true, force: true});
  });

  it("is empty without a conversation id or transcript", () => {
    expect(readAgyPrompts(undefined, tmpHome)).toEqual([]);
    expect(readAgyPrompts("missing", tmpHome)).toEqual([]);
  });

  it("reads the prompts of the conversation's transcript", () => {
    const file = agyTranscriptPath("c-1", tmpHome);
    expect(file).toBe(path.join(tmpHome, ".gemini/antigravity-cli/brain/c-1/.system_generated/logs/transcript_full.jsonl"));
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, userStep("hello") + "\n");
    expect(readAgyPrompts("c-1", tmpHome)).toEqual(["hello"]);
  });
});

describe("createAgyWaitingDetector", () => {
  it("detects the command approval screen", () => {
    const detect = createAgyWaitingDetector();
    expect(detect("\x1b[1mRequesting permission for:\x1b[0m\r\n   touch a.txt\r\nRun this command?")).toBe(true);
  });

  it("detects a signature split across chunks", () => {
    const detect = createAgyWaitingDetector();
    expect(detect("Requesting perm")).toBe(false);
    expect(detect("ission for:\r\n")).toBe(true);
  });

  it("detects a signature split by colour codes", () => {
    const detect = createAgyWaitingDetector();
    expect(detect("Requesting \x1b[38;5;2mpermission\x1b[0m for:")).toBe(true);
  });

  it("reports one screen once", () => {
    const detect = createAgyWaitingDetector();
    detect("Requesting permission for:");
    expect(detect(" more output")).toBe(false);
  });
});

describe("filterAgyEvents", () => {
  // agy conversation ids are uuids
  const ids: Record<string, string> = {
    a: "a071ac23-7cf6-4566-88bb-a9d278961012",
    b: "5c0a7717-e49d-479d-81fd-9cb484963ac0",
    old: "51f82e0c-35eb-45fd-a218-05d0c00de1d0",
    new: "823ed567-d94a-42cd-93c2-efc41c3ae552",
  };
  const ev = (name: string, id: string) => ({hook_event_name: name, conversationId: ids[id]});

  it("takes the first id when none is known", () => {
    expect(filterAgyEvents(undefined, [ev("PreInvocation", "a")]).conversationId).toBe(ids.a);
  });

  it("drops events of another conversation (sub-agents)", () => {
    const result = filterAgyEvents(ids.a, [ev("PreInvocation", "b"), ev("Stop", "a")]);
    expect(result.conversationId).toBe(ids.a);
    expect(result.accepted.map(e => e.hook_event_name)).toEqual(["Stop"]);
  });

  it("adopts the new id on SessionStart", () => {
    const result = filterAgyEvents(ids.old, [ev("SessionStart", "new"), ev("PreInvocation", "new")]);
    expect(result.conversationId).toBe(ids.new);
    expect(result.accepted).toHaveLength(2);
  });

  it("keeps events without an id", () => {
    expect(filterAgyEvents(ids.a, [{hook_event_name: "Stop"}]).accepted).toHaveLength(1);
  });
});

describe("buildAgyHookCommand", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hook-"));
  });
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });
  // agy 1.4.12 Stop input, compact JSON on stdin
  const input = '{"conversationId":"c1","error":"","fullyIdle":true,"modelName":"m","terminationReason":"NO_TOOL_CALL"}';
  const runHook = (env: NodeJS.ProcessEnv) =>
    execFileSync("sh", ["-c", buildAgyHookCommand("Stop")], {input, env: {PATH: process.env.PATH, ...env}, encoding: "utf8"});

  it("appends the event when Agentyard prepared the status file", () => {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, "");
    expect(runHook({[AGY_STATUS_ENV]: file})).toBe("");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({hook_event_name: "Stop", conversationId: "c1", fullyIdle: true});
  });

  it("writes nothing outside Agentyard or without the status file", () => {
    expect(runHook({})).toBe("");
    const missing = path.join(dir, "missing.jsonl");
    expect(runHook({[AGY_STATUS_ENV]: missing})).toBe("");
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe("buildAgyStatusPlugin", () => {
  it("builds the plugin hooks in agy's shape", () => {
    const {manifest, hooks} = buildAgyStatusPlugin() as any;
    expect(manifest.name).toBe("agentyard-status");
    const events = hooks["agentyard-status"];
    expect(Object.keys(events).sort())
      .toEqual(["PostInvocation", "PostToolUse", "PreInvocation", "PreToolUse", "SessionStart", "Stop"]);
    expect(events.Stop[0].type).toBe("command");
    expect(events.PreToolUse[0].matcher).toBe("*");
    expect(events.PreToolUse[0].hooks[0].command).toContain("'PreToolUse'");
  });
});

describe("ensureAgyStatusPlugin", () => {
  let root: string;
  let source: string;
  let installed: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-"));
    source = path.join(root, "source");
    installed = path.join(root, "installed");
  });
  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });
  // `agy plugin list --json` as agy 1.4.12 prints it
  const listed = (enabled: boolean) => JSON.stringify([
    {name: "mattpocock-skills", enabled: true, version: "1.2.3", path: "/x"},
    {name: "agentyard-status", enabled, version: "1.0.0", source: "antigravity", path: installed, hooks: ["agentyard-status"]},
  ]);
  const fakeAgy = (list: string, installStatus = 0) => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[1] === "list") return {status: 0, stdout: list, stderr: ""};
      if (installStatus === 0) {
        fs.mkdirSync(installed, {recursive: true});
        for (const f of ["plugin.json", "hooks.json"]) fs.copyFileSync(path.join(args[2], f), path.join(installed, f));
      }
      return {status: installStatus, stdout: "", stderr: installStatus ? "boom" : ""};
    };
    return {calls, run};
  };

  it("installs when missing", () => {
    const agy = fakeAgy("[]");
    expect(ensureAgyStatusPlugin({binary: "agy", sourceDir: source, run: agy.run})).toEqual({ok: true});
    expect(agy.calls).toEqual([["plugin", "list", "--json"], ["plugin", "install", source]]);
  });

  it("skips an installed, unchanged plugin and reinstalls a changed one", () => {
    writeAgyStatusPlugin(installed);
    const agy = fakeAgy(listed(true));
    expect(ensureAgyStatusPlugin({binary: "agy", sourceDir: source, run: agy.run})).toEqual({ok: true});
    expect(agy.calls).toHaveLength(1);
    fs.writeFileSync(path.join(installed, "hooks.json"), "{}");
    const again = fakeAgy(listed(true));
    ensureAgyStatusPlugin({binary: "agy", sourceDir: source, run: again.run});
    expect(again.calls[1]).toEqual(["plugin", "install", source]);
  });

  it("does not re-enable a plugin the user disabled", () => {
    const agy = fakeAgy(listed(false));
    const result = ensureAgyStatusPlugin({binary: "agy", sourceDir: source, run: agy.run});
    expect(result).toMatchObject({ok: false, reason: "disabled"});
    expect(agy.calls).toHaveLength(1);
  });

  it("reports install failure without throwing", () => {
    const agy = fakeAgy("[]", 1);
    expect(ensureAgyStatusPlugin({binary: "agy", sourceDir: source, run: agy.run})).toMatchObject({ok: false, reason: "failed"});
    const broken = ensureAgyStatusPlugin({binary: "agy", sourceDir: source, run: () => { throw new Error("spawn agy ENOENT"); }});
    expect(broken).toMatchObject({ok: false, reason: "failed"});
  });
});

describe("agyPromptsOf", () => {
  // agy's /fork carries the conversation over but writes only the steps after the fork to its transcript
  const transcripts: Record<string, string[]> = {
    orig: ["one", "two", "after the fork"],
    fork: ["mine"],
    fork2: ["deeper"],
  };
  const read = (id: string | undefined) => (id ? transcripts[id] ?? [] : []);
  const orig = {agentConversationId: "orig"};
  const fork = {agentConversationId: "fork", forkedFrom: "orig", forkedPromptCount: 2};

  it("prefixes a fork's prompts with the original's prompts up to the fork", () => {
    expect(agyPromptsOf(fork, [orig, fork], read)).toEqual(["one", "two", "mine"]);
    expect(agyPromptsOf({forkedFrom: "orig", forkedPromptCount: 2}, [orig], read)).toEqual(["one", "two"]);
    expect(agyPromptsOf(orig, [orig, fork], read)).toEqual(["one", "two", "after the fork"]);
  });

  it("follows a fork of a fork through the original's inherited prompts", () => {
    const fork2 = {agentConversationId: "fork2", forkedFrom: "fork", forkedPromptCount: 3};
    expect(agyPromptsOf(fork2, [orig, fork, fork2], read)).toEqual(["one", "two", "mine", "deeper"]);
  });

  it("reads the original's transcript when its session is gone", () => {
    expect(agyPromptsOf(fork, [fork], read)).toEqual(["one", "two", "mine"]);
  });
});

describe("filterAgyEvents ids", () => {
  it("ignores conversation ids that are not uuids", () => {
    const result = filterAgyEvents(undefined, [{hook_event_name: "SessionStart", conversationId: "x; touch /tmp/p"}]);
    expect(result.conversationId).toBeUndefined();
    expect(result.accepted).toEqual([]);
  });
});

describe("adoptAgyConversation", () => {
  const A = "a071ac23-7cf6-4566-88bb-a9d278961012";
  const B = "5c0a7717-e49d-479d-81fd-9cb484963ac0";
  const fork = {forkedFrom: A, forkedPromptCount: 2};

  it("keeps a fork's inherited prompts when it learns its first id", () => {
    expect(adoptAgyConversation(fork, B)).toEqual({agentConversationId: B, forkedFrom: A, forkedPromptCount: 2});
  });

  it("drops the inheritance when the conversation changes (e.g. /clear)", () => {
    const C = "823ed567-d94a-42cd-93c2-efc41c3ae552";
    expect(adoptAgyConversation({...fork, agentConversationId: B}, C)).toEqual({agentConversationId: C});
  });

  it("does not let a fork take over the original's conversation", () => {
    // /fork was not sent: agy reports the original's id
    expect(adoptAgyConversation(fork, A)).toEqual(fork);
  });
});
