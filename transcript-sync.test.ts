import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { centralSessionsDir, claudeProjectFolder } from "./claude-paths";
import { ClaudeProcess } from "./process-scan";
import { TranscriptMeta } from "./transcript-meta";
import {
  ADOPT_MIN_AGE_MS,
  canAdoptForMove,
  checkSessionGate,
  moveSessionLink,
  pendingAdoptionMtime,
  runSyncTick,
  SyncInput,
  transcriptExists,
} from "./transcript-sync";
import { PersistedSession, Project, SessionType } from "./types";

const U1 = "11111111-2222-3333-4444-555555555555";
const U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const U3 = "99999999-8888-7777-6666-555555555555";

let home: string;
let dirA: string;
let dirB: string;
let folderA: string;
let folderB: string;
let central: string;
let project: Project;
// Fixed clock: transcripts are written with an old mtime unless a test says otherwise.
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const OLD = NOW - 10 * 60 * 1000;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-sync-"));
  dirA = path.join(home, "work", "a");
  dirB = path.join(home, "work", "b");
  folderA = claudeProjectFolder(dirA, home);
  folderB = claudeProjectFolder(dirB, home);
  central = centralSessionsDir(home);
  fs.mkdirSync(folderA, { recursive: true });
  fs.mkdirSync(folderB, { recursive: true });
  project = { id: "p1", name: "proj", dirs: [dirA, dirB] };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function writeTranscript(folder: string, uuid: string, content: string, mtimeMs = OLD): string {
  const file = path.join(folder, `${uuid}.jsonl`);
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function titled(title: string): string {
  return line({ type: "user", message: { content: "hello there" } }) + line({ type: "ai-title", aiTitle: title });
}

function makeInput(overrides: Partial<SyncInput> = {}): SyncInput {
  let n = 1;
  return {
    projects: [project],
    sessions: [],
    hidden: new Set(),
    openUuids: new Set(),
    external: [],
    index: new Map<string, TranscriptMeta>(),
    centralDir: central,
    home,
    nextNumber: () => n++,
    now: NOW,
    ...overrides,
  };
}

function isLink(p: string): boolean {
  return fs.lstatSync(p).isSymbolicLink();
}

describe("runSyncTick", () => {
  it("imports real transcript with title and adopts it", () => {
    writeTranscript(folderA, U1, titled("Fix the login bug"));

    const result = runSyncTick(makeInput());

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    const s = result.sessions[0];
    expect(s).toMatchObject({
      id: `session-${U1}`,
      number: 1,
      name: "Fix the login bug",
      config: { projectDir: dirA, sessionType: SessionType.LOCAL, codingAgent: "claude", skipPermissions: false },
      sessionUuid: U1,
      projectId: "p1",
      origin: "imported",
      manualName: false,
      linkedDir: dirA,
    });
    expect(s.createdAt).toBe(OLD);
    expect(s.lastActivity).toBe(OLD);
    expect(isLink(path.join(folderA, `${U1}.jsonl`))).toBe(true);
    expect(fs.readFileSync(path.join(central, `${U1}.jsonl`), "utf8")).toBe(titled("Fix the login bug"));
  });

  it("falls back to Session <n> when the transcript has no title", () => {
    writeTranscript(folderA, U1, "");

    const result = runSyncTick(makeInput({ nextNumber: () => 7 }));

    expect(result.sessions[0].name).toBe("Session 7");
    expect(result.sessions[0].number).toBe(7);
  });

  it("does not adopt when open in agentyard", () => {
    const file = writeTranscript(folderA, U1, titled("t"));

    const result = runSyncTick(makeInput({ openUuids: new Set([U1]) }));

    expect(result.sessions).toHaveLength(1);
    expect(isLink(file)).toBe(false);
    expect(fs.existsSync(path.join(central, `${U1}.jsonl`))).toBe(false);
  });

  it("does not adopt when externally open by uuid", () => {
    const file = writeTranscript(folderA, U1, titled("t"));
    const external: ClaudeProcess[] = [{ pid: 42, cwd: dirA, sessionUuid: U1 }];

    const result = runSyncTick(makeInput({ external }));

    expect(result.externallyOpen).toEqual(new Set([U1]));
    expect(result.sessions).toHaveLength(1);
    expect(isLink(file)).toBe(false);
  });

  it("marks newest file externally open when uuid unknown", () => {
    const older = writeTranscript(folderA, U1, titled("old"), OLD - 1000);
    const newer = writeTranscript(folderA, U2, titled("new"), OLD);
    const external: ClaudeProcess[] = [{ pid: 42, cwd: dirA }];

    const result = runSyncTick(makeInput({ external }));

    expect(result.externallyOpen).toEqual(new Set([U2]));
    expect(isLink(newer)).toBe(false);
    // the folder is locked: nothing in it is adopted while an unidentified process runs there
    expect(isLink(older)).toBe(false);
    expect(result.sessions).toHaveLength(2);
  });

  it("marks and protects K files for K unidentified processes", () => {
    const a = writeTranscript(folderA, U1, titled("a"), OLD - 1000);
    const b = writeTranscript(folderA, U2, titled("b"), OLD);
    const c = writeTranscript(folderA, U3, titled("c"), OLD - 5000);
    const external: ClaudeProcess[] = [{ pid: 1, cwd: dirA }, { pid: 2, cwd: dirA }];

    const result = runSyncTick(makeInput({ external }));

    expect(result.externallyOpen).toEqual(new Set([U1, U2]));
    expect(isLink(a)).toBe(false);
    expect(isLink(b)).toBe(false);
    expect(isLink(c)).toBe(false);
    expect(fs.existsSync(central)).toBe(false);
  });

  it("an agentyard-open link newer than a real file does not shadow it", () => {
    fs.mkdirSync(central, { recursive: true });
    const target = path.join(central, `${U2}.jsonl`);
    fs.writeFileSync(target, titled("fleet"));
    fs.utimesSync(target, OLD / 1000, OLD / 1000);
    fs.symlinkSync(target, path.join(folderA, `${U2}.jsonl`));
    const real = writeTranscript(folderA, U1, titled("ext"), OLD - 60_000);
    const external: ClaudeProcess[] = [{ pid: 1, cwd: dirA }];

    const result = runSyncTick(makeInput({ external, openUuids: new Set([U2]) }));

    expect(result.externallyOpen).toEqual(new Set([U1]));
    expect(isLink(real)).toBe(false);
  });

  it("marks every file tied at the cutoff mtime", () => {
    writeTranscript(folderA, U1, titled("a"), OLD);
    writeTranscript(folderA, U2, titled("b"), OLD);
    writeTranscript(folderA, U3, titled("c"), OLD - 1000);
    const external: ClaudeProcess[] = [{ pid: 1, cwd: dirA }];

    const result = runSyncTick(makeInput({ external }));

    expect(result.externallyOpen).toEqual(new Set([U1, U2]));
  });

  it("an unidentified process inside the directory locks its folder", () => {
    const file = writeTranscript(folderA, U1, titled("t"));
    const external: ClaudeProcess[] = [{ pid: 1, cwd: path.join(dirA, "sub") }];

    const result = runSyncTick(makeInput({ external }));

    expect(isLink(file)).toBe(false);
    expect(result.externallyOpen).toEqual(new Set([U1]));
  });

  it("does not treat a sibling directory with a shared prefix as inside", () => {
    const file = writeTranscript(folderA, U1, titled("t"));
    const external: ClaudeProcess[] = [{ pid: 1, cwd: dirA + "0" }];

    const result = runSyncTick(makeInput({ external }));

    expect(result.externallyOpen.size).toBe(0);
    expect(isLink(file)).toBe(true);
  });

  it("compares uuids case-insensitively but keeps the on-disk name for paths", () => {
    const upper = U2.toUpperCase();
    const file = writeTranscript(folderA, upper, titled("t"));

    const hiddenResult = runSyncTick(makeInput({ hidden: new Set([U2]) }));
    expect(hiddenResult.sessions).toHaveLength(0);

    const result = runSyncTick(makeInput());
    expect(result.warnings).toEqual([]);
    expect(result.sessions[0].sessionUuid).toBe(U2);
    expect(isLink(file)).toBe(true);
    expect(fs.existsSync(path.join(central, `${upper}.jsonl`))).toBe(true);
  });

  it("reports failed and never throws when the whole tick aborts", () => {
    const broken: Project = { id: "x", name: "x", dirs: [null as unknown as string] };

    const result = runSyncTick(makeInput({ projects: [broken] }));

    expect(result.failed).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.warnings[0]).toMatch(/^sync tick failed/);
  });

  it("ignores an unknown-uuid process in another directory", () => {
    const file = writeTranscript(folderA, U1, titled("t"));
    const external: ClaudeProcess[] = [{ pid: 42, cwd: path.join(home, "elsewhere") }];

    const result = runSyncTick(makeInput({ external }));

    expect(result.externallyOpen.size).toBe(0);
    expect(isLink(file)).toBe(true);
  });

  it("does not adopt a transcript modified within the safety window", () => {
    const file = writeTranscript(folderA, U1, titled("t"), NOW - ADOPT_MIN_AGE_MS + 1000);

    const result = runSyncTick(makeInput());

    expect(result.sessions).toHaveLength(1);
    expect(isLink(file)).toBe(false);
    expect(fs.existsSync(path.join(central, `${U1}.jsonl`))).toBe(false);
  });

  it("does not adopt a uuid that exists as real file in two folders", () => {
    const a = writeTranscript(folderA, U1, titled("one"));
    const b = writeTranscript(folderB, U1, titled("two-longer"));

    const result = runSyncTick(makeInput());

    expect(result.warnings).toEqual([`duplicate transcript ${U1} in ${folderA}, ${folderB}`]);
    expect(result.sessions).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(isLink(a)).toBe(false);
    expect(isLink(b)).toBe(false);
    expect(fs.readFileSync(a, "utf8")).toBe(titled("one"));
    expect(fs.readFileSync(b, "utf8")).toBe(titled("two-longer"));
    expect(fs.existsSync(path.join(central, `${U1}.jsonl`))).toBe(false);
  });

  it("warns when an adopted link became a real file", () => {
    fs.mkdirSync(central, { recursive: true });
    fs.writeFileSync(path.join(central, `${U1}.jsonl`), titled("central copy"));
    const file = writeTranscript(folderA, U1, titled("local copy"));

    const result = runSyncTick(makeInput());

    expect(result.warnings).toEqual([`link for ${U1} became a real file in ${folderA}`]);
    expect(isLink(file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(titled("local copy"));
    expect(fs.readFileSync(path.join(central, `${U1}.jsonl`), "utf8")).toBe(titled("central copy"));
  });

  it("reads metadata through an existing link", () => {
    fs.mkdirSync(central, { recursive: true });
    const target = path.join(central, `${U1}.jsonl`);
    fs.writeFileSync(target, titled("via link"));
    fs.symlinkSync(target, path.join(folderA, `${U1}.jsonl`));

    const result = runSyncTick(makeInput());

    expect(result.warnings).toEqual([]);
    expect(result.sessions[0].name).toBe("via link");
    expect(fs.readFileSync(target, "utf8")).toBe(titled("via link"));
  });

  it("skips hidden uuids", () => {
    const file = writeTranscript(folderA, U1, titled("t"));

    const result = runSyncTick(makeInput({ hidden: new Set([U1]) }));

    expect(result.sessions).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(isLink(file)).toBe(false);
  });

  it("ignores names that are not <uuid>.jsonl and sidecar dirs", () => {
    writeTranscript(folderA, "not-a-uuid", titled("t"));
    fs.mkdirSync(path.join(folderA, U2), { recursive: true });
    fs.mkdirSync(path.join(folderA, `${U1}.jsonl`));

    const result = runSyncTick(makeInput());

    expect(result.sessions).toHaveLength(0);
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(central)).toBe(false);
  });

  it("keeps manual name", () => {
    writeTranscript(folderA, U1, titled("Generated title"));
    const existing: PersistedSession = {
      id: "s1",
      number: 3,
      name: "My name",
      config: { projectDir: dirA, sessionType: SessionType.LOCAL, codingAgent: "claude", skipPermissions: false },
      createdAt: 1,
      sessionUuid: U1,
      projectId: "p1",
      manualName: true,
      lastActivity: 1,
    };

    const result = runSyncTick(makeInput({ sessions: [existing] }));

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].name).toBe("My name");
    expect(result.sessions[0].lastActivity).toBe(OLD);
    expect(result.changed).toBe(true);
    expect(existing.lastActivity).toBe(1);
  });

  it("treats a session without manualName as manually named", () => {
    writeTranscript(folderA, U1, titled("Generated title"));
    const legacy: PersistedSession = {
      id: "s1",
      number: 3,
      name: "Renamed by user",
      config: { projectDir: dirA, sessionType: SessionType.LOCAL, codingAgent: "claude", skipPermissions: false },
      createdAt: 1,
      sessionUuid: U1,
    };

    const result = runSyncTick(makeInput({ sessions: [legacy] }));

    expect(result.sessions[0].name).toBe("Renamed by user");
  });

  it("updates name of a non-manual session", () => {
    writeTranscript(folderA, U1, titled("Fresh title"));
    const existing: PersistedSession = {
      id: "s1",
      number: 3,
      name: "Session 3",
      config: { projectDir: dirA, sessionType: SessionType.LOCAL, codingAgent: "claude", skipPermissions: false },
      createdAt: 1,
      sessionUuid: U1,
      manualName: false,
      lastActivity: OLD + 5,
    };

    const result = runSyncTick(makeInput({ sessions: [existing] }));

    expect(result.sessions[0].name).toBe("Fresh title");
    expect(result.sessions[0].lastActivity).toBe(OLD + 5);
  });

  it("changed is false on second identical tick", () => {
    writeTranscript(folderA, U1, titled("t"));
    const input = makeInput();

    const first = runSyncTick(input);
    const second = runSyncTick({ ...input, sessions: first.sessions });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.sessions).toEqual(first.sessions);
    expect(second.warnings).toEqual([]);
  });

  it("never throws and reports per-entry errors", () => {
    fs.symlinkSync(path.join(home, "nowhere.jsonl"), path.join(folderA, `${U1}.jsonl`));
    writeTranscript(folderA, U2, titled("fine"));

    const result = runSyncTick(makeInput());

    expect(result.sessions.map(s => s.sessionUuid)).toEqual([U2]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(folderA);
    expect(result.warnings[0]).toContain(U1);
  });
});

describe("runSyncTick with links", () => {
  function linkTranscript(folder: string, uuid: string, content: string, mtimeMs = OLD): string {
    fs.mkdirSync(central, { recursive: true });
    const target = path.join(central, `${uuid}.jsonl`);
    fs.writeFileSync(target, content);
    fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
    const link = path.join(folder, `${uuid}.jsonl`);
    fs.symlinkSync(target, link);
    return link;
  }

  function lateSidecar(folder: string, uuid: string, mtimeMs = OLD): string {
    const dir = path.join(folder, uuid);
    fs.mkdirSync(path.join(dir, "subagents"), { recursive: true });
    const file = path.join(dir, "subagents", "a.jsonl");
    fs.writeFileSync(file, "sub");
    for (const p of [file, path.join(dir, "subagents"), dir]) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return dir;
  }

  it("marks a linked transcript open for a uuid-less process in its directory", () => {
    linkTranscript(folderA, U1, titled("linked"), OLD);
    writeTranscript(folderA, U2, titled("older real"), OLD - 60_000);
    const external: ClaudeProcess[] = [{ pid: 1, cwd: dirA }];

    const result = runSyncTick(makeInput({ external }));

    expect(result.externallyOpen).toEqual(new Set([U1]));
  });

  it("adopts a sidecar created after adoption (sidecar-only)", () => {
    linkTranscript(folderA, U1, titled("t"));
    const dir = lateSidecar(folderA, U1);

    const result = runSyncTick(makeInput());

    expect(result.warnings).toEqual([]);
    expect(isLink(dir)).toBe(true);
    expect(fs.readlinkSync(dir)).toBe(path.join(central, U1));
    expect(fs.readFileSync(path.join(central, U1, "subagents", "a.jsonl"), "utf8")).toBe("sub");
  });

  it("does not adopt a sidecar while it is recently written, open, or its folder is locked", () => {
    linkTranscript(folderA, U1, titled("t"));
    const recent = lateSidecar(folderA, U1, NOW - 1000);
    runSyncTick(makeInput());
    expect(isLink(recent)).toBe(false);

    fs.rmSync(recent, { recursive: true });
    const dir = lateSidecar(folderA, U1);
    runSyncTick(makeInput({ openUuids: new Set([U1]) }));
    expect(isLink(dir)).toBe(false);
    runSyncTick(makeInput({ external: [{ pid: 1, cwd: dirB, sessionUuid: U1 }] }));
    expect(isLink(dir)).toBe(false);
    runSyncTick(makeInput({ external: [{ pid: 1, cwd: dirA }] }));
    expect(isLink(dir)).toBe(false);
  });

  it("warns instead of merging when central already has the sidecar", () => {
    linkTranscript(folderA, U1, titled("t"));
    fs.mkdirSync(path.join(central, U1));
    const dir = lateSidecar(folderA, U1);

    const result = runSyncTick(makeInput());

    expect(isLink(dir)).toBe(false);
    expect(result.warnings.some(w => w.includes("also exists centrally"))).toBe(true);
  });
});

describe("moveSessionLink", () => {
  function session(linkedDir: string | undefined, projectDir = linkedDir ?? ""): PersistedSession {
    return {
      id: `session-${U1}`,
      number: 1,
      name: "S",
      config: { projectDir, sessionType: SessionType.LOCAL, codingAgent: "claude", skipPermissions: false },
      createdAt: OLD,
      sessionUuid: U1,
      projectId: "p1",
      origin: "agentyard",
      manualName: false,
      linkedDir,
    };
  }

  it("moveSessionLink adopts real file then relinks", () => {
    writeTranscript(folderA, U1, titled("Hi"));
    fs.mkdirSync(path.join(folderA, U1));
    fs.writeFileSync(path.join(folderA, U1, "side.txt"), "x");

    moveSessionLink(session(dirA), dirB, home, central);

    expect(fs.readFileSync(path.join(central, `${U1}.jsonl`), "utf8")).toBe(titled("Hi"));
    expect(fs.existsSync(path.join(folderA, `${U1}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(folderA, U1))).toBe(false);
    expect(isLink(path.join(folderB, `${U1}.jsonl`))).toBe(true);
    expect(fs.readlinkSync(path.join(folderB, `${U1}.jsonl`))).toBe(path.join(central, `${U1}.jsonl`));
    expect(isLink(path.join(folderB, U1))).toBe(true);
    expect(fs.readFileSync(path.join(folderB, U1, "side.txt"), "utf8")).toBe("x");
  });

  it("moveSessionLink relinks an existing central link", () => {
    fs.mkdirSync(central, { recursive: true });
    fs.writeFileSync(path.join(central, `${U1}.jsonl`), "data");
    fs.symlinkSync(path.join(central, `${U1}.jsonl`), path.join(folderA, `${U1}.jsonl`));

    moveSessionLink(session(dirA), dirB, home, central);

    expect(fs.existsSync(path.join(folderA, `${U1}.jsonl`))).toBe(false);
    expect(fs.readFileSync(path.join(folderB, `${U1}.jsonl`), "utf8")).toBe("data");
  });

  it("moveSessionLink recreates missing link from central", () => {
    fs.mkdirSync(path.join(central, U1), { recursive: true });
    fs.writeFileSync(path.join(central, `${U1}.jsonl`), "data");
    const folderC = claudeProjectFolder(path.join(home, "work", "c"), home);

    moveSessionLink(session(dirA), path.join(home, "work", "c"), home, central);

    expect(fs.readlinkSync(path.join(folderC, `${U1}.jsonl`))).toBe(path.join(central, `${U1}.jsonl`));
    expect(fs.readlinkSync(path.join(folderC, U1))).toBe(path.join(central, U1));
    expect(fs.readFileSync(path.join(central, `${U1}.jsonl`), "utf8")).toBe("data");
  });

  it("moveSessionLink recreates link for a session without a linked dir", () => {
    fs.mkdirSync(central, { recursive: true });
    fs.writeFileSync(path.join(central, `${U1}.jsonl`), "data");

    moveSessionLink(session(undefined, ""), dirB, home, central);

    expect(fs.readFileSync(path.join(folderB, `${U1}.jsonl`), "utf8")).toBe("data");
    // a central sidecar is always linked, so one Claude creates later lands centrally
    expect(fs.readlinkSync(path.join(folderB, U1))).toBe(path.join(central, U1));
    expect(fs.readdirSync(path.join(central, U1))).toEqual([]);
  });

  it("moveSessionLink centralizes a sidecar created after adoption, then relinks", () => {
    writeTranscript(folderA, U1, titled("Hi"));
    runSyncTick(makeInput());
    // Simulate a sidecar left as a real directory by an adoption made before sidecars were always linked.
    fs.unlinkSync(path.join(folderA, U1));
    fs.rmdirSync(path.join(central, U1));
    fs.mkdirSync(path.join(folderA, U1, "subagents"), { recursive: true });
    fs.writeFileSync(path.join(folderA, U1, "subagents", "late.jsonl"), "late");

    moveSessionLink(session(dirA), dirB, home, central);

    expect(fs.existsSync(path.join(folderA, `${U1}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(folderA, U1))).toBe(false);
    expect(fs.readlinkSync(path.join(folderB, U1))).toBe(path.join(central, U1));
    expect(fs.readFileSync(path.join(folderB, U1, "subagents", "late.jsonl"), "utf8")).toBe("late");
    expect(fs.readFileSync(path.join(folderB, `${U1}.jsonl`), "utf8")).toBe(titled("Hi"));
  });

  it("moveSessionLink throws when the transcript is nowhere", () => {
    expect(() => moveSessionLink(session(dirA), dirB, home, central)).toThrow(`Transcript ${U1} not found`);
    expect(fs.readdirSync(folderB)).toEqual([]);
  });

  it("moveSessionLink throws on foreign link", () => {
    const elsewhere = path.join(home, "elsewhere.jsonl");
    fs.writeFileSync(elsewhere, "mine");
    fs.symlinkSync(elsewhere, path.join(folderA, `${U1}.jsonl`));

    expect(() => moveSessionLink(session(dirA), dirB, home, central)).toThrow(`Unexpected link for ${U1}`);
    expect(fs.readlinkSync(path.join(folderA, `${U1}.jsonl`))).toBe(elsewhere);
    expect(fs.readdirSync(folderB)).toEqual([]);
  });

  it("moveSessionLink never overwrites a file in the target folder", () => {
    writeTranscript(folderA, U1, "source");
    writeTranscript(folderB, U1, "target");

    expect(() => moveSessionLink(session(dirA), dirB, home, central)).toThrow();
    expect(fs.readFileSync(path.join(folderB, `${U1}.jsonl`), "utf8")).toBe("target");
    expect(fs.readFileSync(path.join(folderA, `${U1}.jsonl`), "utf8")).toBe("source");
  });

  it("moveSessionLink does nothing for the same directory", () => {
    writeTranscript(folderA, U1, "source");

    moveSessionLink(session(dirA), dirA, home, central);

    expect(fs.lstatSync(path.join(folderA, `${U1}.jsonl`)).isFile()).toBe(true);
    expect(fs.existsSync(central)).toBe(false);
  });
});

describe("canAdoptForMove", () => {
  const base = { srcDir: "/w/acme1", external: [] as ClaudeProcess[], mtimeMs: NOW - ADOPT_MIN_AGE_MS, now: NOW };
  const busy = "Directory /w/acme1 has an active Claude; close it first";

  it("allows an old transcript in an idle directory", () => {
    expect(canAdoptForMove(base)).toEqual({ ok: true });
  });

  it("allows an external claude with another uuid in the source dir (it writes its own transcript)", () => {
    const external = [{ pid: 1, cwd: "/w/acme1", sessionUuid: U2 }];
    expect(canAdoptForMove({ ...base, external })).toEqual({ ok: true });
  });

  it("refuses when a uuid-less external claude runs below the source dir", () => {
    const external = [{ pid: 1, cwd: "/w/acme1/sub" }];
    expect(canAdoptForMove({ ...base, external })).toEqual({ ok: false, error: busy });
  });

  it("ignores processes in a sibling directory sharing a prefix", () => {
    const external = [{ pid: 1, cwd: "/w/acme10" }];
    expect(canAdoptForMove({ ...base, external })).toEqual({ ok: true });
  });

  it("refuses a recently written transcript", () => {
    expect(canAdoptForMove({ ...base, mtimeMs: NOW - ADOPT_MIN_AGE_MS + 1 })).toEqual({
      ok: false,
      error: "Conversation is still being written; try again shortly",
    });
  });
});

describe("transcriptExists", () => {
  it("finds the transcript centrally or in a directory's folder, else not", () => {
    expect(transcriptExists(U1, [dirA, dirB, ""], home, central)).toBe(false);
    writeTranscript(folderB, U1, "x");
    expect(transcriptExists(U1, [dirA, dirB], home, central)).toBe(true);
    expect(transcriptExists(U1, [dirA], home, central)).toBe(false);
    fs.mkdirSync(central, { recursive: true });
    fs.writeFileSync(path.join(central, `${U1}.jsonl`), "x");
    expect(transcriptExists(U1, [], home, central)).toBe(true);
  });
});

describe("pendingAdoptionMtime", () => {
  it("is null for a missing transcript or a link with a linked sidecar", () => {
    expect(pendingAdoptionMtime(folderA, U1, central)).toBeNull();
    writeTranscript(folderA, U1, "x");
    runSyncTick(makeInput());
    expect(pendingAdoptionMtime(folderA, U1, central)).toBeNull();
  });

  it("returns the newest mtime of a real transcript and a real sidecar", () => {
    writeTranscript(folderA, U1, "x", OLD - 5000);
    fs.mkdirSync(path.join(folderA, U1));
    fs.writeFileSync(path.join(folderA, U1, "a"), "a");
    fs.utimesSync(path.join(folderA, U1, "a"), OLD / 1000, OLD / 1000);
    fs.utimesSync(path.join(folderA, U1), (OLD - 9000) / 1000, (OLD - 9000) / 1000);
    expect(pendingAdoptionMtime(folderA, U1, central)).toBe(OLD);
  });

  it("returns the sidecar mtime for a link with a late real sidecar", () => {
    fs.mkdirSync(central, { recursive: true });
    fs.writeFileSync(path.join(central, `${U1}.jsonl`), "x");
    fs.symlinkSync(path.join(central, `${U1}.jsonl`), path.join(folderA, `${U1}.jsonl`));
    fs.mkdirSync(path.join(folderA, U1));
    fs.utimesSync(path.join(folderA, U1), OLD / 1000, OLD / 1000);
    expect(pendingAdoptionMtime(folderA, U1, central)).toBe(OLD);
  });
});

describe("checkSessionGate", () => {
  const free = { ok: true };
  const inUse = (n: number) => ({ ok: true, warning: `/w/b already has ${n} active agent${n === 1 ? "" : "s"}` });
  const base = { external: [] as ClaudeProcess[], running: [], sessionId: "s1", sessionUuid: U1, targetDir: "/w/b" };

  it("allows a free target", () => {
    expect(checkSessionGate(base)).toEqual(free);
    expect(checkSessionGate({ ...base, sourceDir: "/w/a" })).toEqual(free);
  });

  it("refuses when any process has the session's uuid, wherever it runs", () => {
    const external = [{ pid: 1, cwd: "/elsewhere", sessionUuid: U1.toUpperCase() }];
    expect(checkSessionGate({ ...base, external })).toEqual({ ok: false, error: "Session is open elsewhere" });
  });

  it("refuses a move when a uuid-less claude runs in the source dir (it may be writing this transcript)", () => {
    const busy = { ok: false, error: "Directory /w/a has an unidentified Claude; close it first" };
    const withSource = { ...base, sourceDir: "/w/a" };
    expect(checkSessionGate({ ...withSource, external: [{ pid: 1, cwd: "/w/a/sub" }] })).toEqual(busy);
    expect(checkSessionGate({ ...withSource, external: [{ pid: 1, cwd: "/w/ab" }] })).toEqual(free);
  });

  it("does not block a move for identified agents in the source dir", () => {
    const withSource = { ...base, sourceDir: "/w/a" };
    expect(checkSessionGate({ ...withSource, external: [{ pid: 1, cwd: "/w/a", sessionUuid: U2 }] })).toEqual(free);
    expect(checkSessionGate({ ...withSource, running: [{ sessionId: "s2", sessionName: "x", dir: "/w/a" }] })).toEqual(free);
  });

  it("warns (but allows) when the target already has active agents, never counting the session itself", () => {
    expect(checkSessionGate({ ...base, external: [{ pid: 1, cwd: "/w/b" }] })).toEqual(inUse(1));
    expect(checkSessionGate({
      ...base,
      external: [{ pid: 1, cwd: "/w/b/sub" }],
      running: [{ sessionId: "s2", sessionName: "x", dir: "/w/b" }],
    })).toEqual(inUse(2));
    expect(checkSessionGate({ ...base, running: [{ sessionId: "s1", sessionName: "me", dir: "/w/b" }] })).toEqual(free);
  });

  it("treats source equal to target as a reopen: only the warning applies", () => {
    expect(checkSessionGate({ ...base, sourceDir: "/w/b/", external: [{ pid: 1, cwd: "/w/b" }] })).toEqual(inUse(1));
    expect(checkSessionGate({ ...base, sourceDir: "/w/b" })).toEqual(free);
  });
});
