import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {parseClaudeCmdline, scanClaudeProcesses} from "./process-scan";

const UUID = "11111111-2222-4333-8444-555555555555";
const UUID2 = "11111111-2222-3333-4444-555555555555";

describe("parseClaudeCmdline", () => {
  it("detects plain claude without uuid", () => {
    expect(parseClaudeCmdline(["claude"])).toEqual({isClaude: true, sessionUuid: undefined});
  });
  it("parses --resume X, -r X, --session-id X", () => {
    expect(parseClaudeCmdline(["/usr/bin/claude", "--resume", UUID]).sessionUuid).toBe(UUID);
    expect(parseClaudeCmdline(["claude", "-r", UUID]).sessionUuid).toBe(UUID);
    expect(parseClaudeCmdline(["claude", "--session-id", UUID]).sessionUuid).toBe(UUID);
  });
  it("parses --flag=value forms", () => {
    const argv = ["/x/native-binary/claude", "--output-format", "stream-json", `--resume=${UUID}`];
    expect(parseClaudeCmdline(argv)).toEqual({isClaude: true, sessionUuid: UUID});
    expect(parseClaudeCmdline(["claude", `--session-id=${UUID2}`]).sessionUuid).toBe(UUID2);
  });
  it("ignores non-uuid values", () => {
    expect(parseClaudeCmdline(["claude", "--resume", "not-a-uuid"]).sessionUuid).toBeUndefined();
    expect(parseClaudeCmdline(["claude", "--resume=abc"]).sessionUuid).toBeUndefined();
  });
  it("detects node cli.js", () => {
    const argv = ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "--resume", UUID];
    expect(parseClaudeCmdline(argv)).toEqual({isClaude: true, sessionUuid: UUID});
  });
  it("rejects other programs", () => {
    expect(parseClaudeCmdline(["bash", "-c", "ls"]).isClaude).toBe(false);
    expect(parseClaudeCmdline([]).isClaude).toBe(false);
  });
});

describe("scanClaudeProcesses", () => {
  let root: string;
  let cwdTarget: string;

  const addPid = (pid: string, argv: string[], env: string[] = ["PATH=/usr/bin"]) => {
    const dir = path.join(root, pid);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "cmdline"), argv.join("\0") + "\0");
    fs.writeFileSync(path.join(dir, "environ"), env.join("\0") + "\0");
    fs.symlinkSync(cwdTarget, path.join(dir, "cwd"));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
    cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cwd-"));
  });
  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(cwdTarget, {recursive: true, force: true});
  });

  it("detects claude with --resume uuid", () => {
    addPid("100", ["claude", `--resume=${UUID}`]);
    expect(scanClaudeProcesses(root)).toEqual([{pid: 100, cwd: cwdTarget, sessionUuid: UUID}]);
  });

  it("detects node-launched cli.js", () => {
    addPid("101", ["node", "/a/@anthropic-ai/claude-code/cli.js", "--session-id", UUID]);
    const res = scanClaudeProcesses(root);
    expect(res).toHaveLength(1);
    expect(res[0].sessionUuid).toBe(UUID);
  });

  it("excludes processes with AGENTYARD_SESSION_ID", () => {
    addPid("102", ["claude"], ["A=1", "AGENTYARD_SESSION_ID=abc"]);
    addPid("103", ["claude"]);
    expect(scanClaudeProcesses(root).map(p => p.pid)).toEqual([103]);
  });

  it("excludes processes with the legacy FLEETCODE_SESSION_ID", () => {
    addPid("109", ["claude"], ["FLEETCODE_SESSION_ID=abc", "B=2"]);
    addPid("110", ["claude"], ["AGENTYARD_SESSION=abc"]);
    expect(scanClaudeProcesses(root).map(p => p.pid)).toEqual([110]);
  });

  it("ignores non-claude and unreadable pids", () => {
    addPid("104", ["bash"]);
    fs.mkdirSync(path.join(root, "105")); // no files at all
    fs.mkdirSync(path.join(root, "self"));
    addPid("106", ["claude"]);
    addPid("107", ["claude"]);
    fs.mkdirSync(path.join(root, "108")); // claude, but no cwd entry at all
    fs.writeFileSync(path.join(root, "108", "cmdline"), "claude\0");
    fs.writeFileSync(path.join(root, "not-a-pid"), "x");
    const pids = scanClaudeProcesses(root).map(p => p.pid);
    expect(pids).toEqual(expect.arrayContaining([106, 107]));
    expect(pids).not.toContain(104);
    expect(pids).not.toContain(105);
    expect(pids).not.toContain(108);
  });

  it("fails closed: includes claude with unreadable environ", () => {
    addPid("109", ["claude"]);
    fs.chmodSync(path.join(root, "109", "environ"), 0o000);
    expect(scanClaudeProcesses(root).map(p => p.pid)).toContain(109);
  });

  it("strips trailing (deleted) from cwd", () => {
    addPid("110", ["claude"]);
    fs.rmSync(path.join(root, "110", "cwd"));
    fs.symlinkSync("/some/dir (deleted)", path.join(root, "110", "cwd"));
    expect(scanClaudeProcesses(root).find(p => p.pid === 110)?.cwd).toBe("/some/dir");
  });

  it("returns [] for a missing proc root", () => {
    expect(scanClaudeProcesses(path.join(root, "nope"))).toEqual([]);
  });
});
