import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  legacyUserDataDir,
  mergeLegacyConfig,
  migrateConfigScratchPaths,
  migrateDataHome,
  migrateScratchDir,
  migrateUserData,
  relinkTranscripts,
  rewriteScratchPaths,
  runDataMigration,
  USER_DATA_MARKER,
} from "./data-migration";
import {encodeProjectDir} from "./claude-paths";

const UUID = "11111111-2222-3333-4444-555555555555";
const UUID2 = "66666666-7777-4888-9999-000000000000";

let home: string;
let oldHome: string;
let newHome: string;
let projects: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "data-migration-"));
  oldHome = path.join(home, ".fleetcode");
  newHome = path.join(home, ".agentyard");
  projects = path.join(home, ".claude", "projects");
});

afterEach(() => {
  fs.rmSync(home, {recursive: true, force: true});
});

/** FleetCode layout: central store with transcripts + sidecars, links under ~/.claude/projects. */
function seedFleetcode(): {folder: string; realFile: string} {
  const sessions = path.join(oldHome, "sessions");
  fs.mkdirSync(path.join(sessions, UUID, "subagents"), {recursive: true});
  fs.writeFileSync(path.join(sessions, `${UUID}.jsonl`), "line1\nline2\n");
  fs.writeFileSync(path.join(sessions, UUID, "subagents", "a.jsonl"), "sub");
  fs.writeFileSync(path.join(sessions, `${UUID2}.jsonl`), "other\n");
  fs.mkdirSync(path.join(oldHome, "status"), {recursive: true});
  fs.writeFileSync(path.join(oldHome, "status", `${UUID}.jsonl`), "{}\n");

  const folder = path.join(projects, "-w-acme");
  fs.mkdirSync(folder, {recursive: true});
  fs.symlinkSync(path.join(sessions, `${UUID}.jsonl`), path.join(folder, `${UUID}.jsonl`));
  fs.symlinkSync(path.join(sessions, UUID), path.join(folder, UUID), "dir");
  // relative link into the old folder
  fs.symlinkSync(path.relative(folder, path.join(sessions, `${UUID2}.jsonl`)), path.join(folder, `${UUID2}.jsonl`));
  // a real transcript and a foreign link must stay as they are
  const realFile = path.join(folder, "real-session.jsonl");
  fs.writeFileSync(realFile, "real content\n");
  fs.symlinkSync("/somewhere/else.jsonl", path.join(folder, "foreign.jsonl"));
  return {folder, realFile};
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = "dir";
        walk(p);
      } else out[rel] = `file:${fs.readFileSync(p, "utf-8")}`;
    }
  };
  walk(dir);
  return out;
}

describe("migrateDataHome", () => {
  it("is a no-op on a fresh install", () => {
    expect(migrateDataHome(home)).toEqual({action: "none", warnings: []});
    expect(fs.existsSync(oldHome)).toBe(false);
    expect(fs.existsSync(newHome)).toBe(false);
  });

  it("moves the folder and leaves a compatibility link", () => {
    seedFleetcode();
    const before = snapshot(oldHome);
    expect(migrateDataHome(home)).toEqual({action: "renamed", warnings: []});
    expect(fs.lstatSync(newHome).isDirectory()).toBe(true);
    expect(fs.lstatSync(oldHome).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(oldHome)).toBe(newHome);
    expect(snapshot(newHome)).toEqual(before);
    // links not yet retargeted keep resolving through the compatibility link
    expect(fs.readFileSync(path.join(projects, "-w-acme", `${UUID}.jsonl`), "utf-8")).toBe("line1\nline2\n");
  });

  it("changes nothing and warns when both folders exist", () => {
    seedFleetcode();
    fs.mkdirSync(path.join(newHome, "sessions"), {recursive: true});
    const before = snapshot(home);
    const res = migrateDataHome(home);
    expect(res.action).toBe("both-exist");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("not migrating");
    expect(snapshot(home)).toEqual(before);
  });

  it("is idempotent", () => {
    seedFleetcode();
    migrateDataHome(home);
    const after = snapshot(home);
    expect(migrateDataHome(home)).toEqual({action: "already-migrated", warnings: []});
    expect(snapshot(home)).toEqual(after);
  });

  it("warns when the old folder is a symlink elsewhere", () => {
    const elsewhere = path.join(home, "disk", "fleet");
    fs.mkdirSync(elsewhere, {recursive: true});
    fs.symlinkSync(elsewhere, oldHome, "dir");
    const res = migrateDataHome(home);
    expect(res.action).toBe("none");
    expect(res.warnings[0]).toContain("does not point to");
    expect(fs.readlinkSync(oldHome)).toBe(elsewhere);
    expect(fs.existsSync(newHome)).toBe(false);
  });

  it("moves the folder back when the compatibility link cannot be created", () => {
    seedFleetcode();
    const before = snapshot(oldHome);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFs: typeof fs = require("fs");
    const spy = jest.spyOn(rawFs, "symlinkSync").mockImplementationOnce(() => {
      throw new Error("EPERM");
    });
    const res = migrateDataHome(home);
    spy.mockRestore();
    expect(res.action).toBe("failed");
    expect(fs.lstatSync(oldHome).isDirectory()).toBe(true);
    expect(fs.existsSync(newHome)).toBe(false);
    expect(snapshot(oldHome)).toEqual(before);
  });
});

describe("relinkTranscripts", () => {
  it("is a no-op on a fresh install", () => {
    expect(relinkTranscripts(home)).toEqual({relinked: 0, skipped: 0, cleaned: 0, errors: []});
  });

  it("retargets links (file, sidecar dir, relative) and leaves other entries untouched", () => {
    const {folder, realFile} = seedFleetcode();
    const realBytes = fs.readFileSync(realFile);
    const realMtime = fs.statSync(realFile).mtimeMs;
    migrateDataHome(home);

    expect(relinkTranscripts(home)).toEqual({relinked: 3, skipped: 0, cleaned: 0, errors: []});
    expect(fs.readlinkSync(path.join(folder, `${UUID}.jsonl`))).toBe(path.join(newHome, "sessions", `${UUID}.jsonl`));
    expect(fs.readlinkSync(path.join(folder, UUID))).toBe(path.join(newHome, "sessions", UUID));
    expect(fs.readlinkSync(path.join(folder, `${UUID2}.jsonl`))).toBe(path.join(newHome, "sessions", `${UUID2}.jsonl`));
    // targets resolve
    expect(fs.readFileSync(path.join(folder, `${UUID}.jsonl`), "utf-8")).toBe("line1\nline2\n");
    expect(fs.readFileSync(path.join(folder, UUID, "subagents", "a.jsonl"), "utf-8")).toBe("sub");
    expect(fs.readFileSync(path.join(folder, `${UUID2}.jsonl`), "utf-8")).toBe("other\n");
    // real file byte-for-byte, foreign link unchanged, no temp leftovers
    expect(fs.lstatSync(realFile).isFile()).toBe(true);
    expect(fs.readFileSync(realFile).equals(realBytes)).toBe(true);
    expect(fs.statSync(realFile).mtimeMs).toBe(realMtime);
    expect(fs.readlinkSync(path.join(folder, "foreign.jsonl"))).toBe("/somewhere/else.jsonl");
    expect(fs.readdirSync(folder).sort()).toEqual(
      [`${UUID}.jsonl`, UUID, `${UUID2}.jsonl`, "real-session.jsonl", "foreign.jsonl"].sort()
    );
  });

  it("is idempotent", () => {
    seedFleetcode();
    migrateDataHome(home);
    relinkTranscripts(home);
    const after = snapshot(projects);
    expect(relinkTranscripts(home)).toEqual({relinked: 0, skipped: 0, cleaned: 0, errors: []});
    expect(snapshot(projects)).toEqual(after);
  });

  it("does nothing while the old folder is still a real directory", () => {
    seedFleetcode();
    fs.mkdirSync(path.join(newHome, "sessions"), {recursive: true});
    fs.writeFileSync(path.join(newHome, "sessions", `${UUID}.jsonl`), "different copy\n");
    const before = snapshot(projects);
    expect(relinkTranscripts(home)).toEqual({relinked: 0, skipped: 0, cleaned: 0, errors: []});
    expect(snapshot(projects)).toEqual(before);
  });

  it("skips links whose target is missing under the new folder", () => {
    const {folder} = seedFleetcode();
    migrateDataHome(home);
    fs.symlinkSync(path.join(oldHome, "sessions", "gone.jsonl"), path.join(folder, "gone.jsonl"));
    const res = relinkTranscripts(home);
    expect(res).toEqual({relinked: 3, skipped: 1, cleaned: 0, errors: []});
    expect(fs.readlinkSync(path.join(folder, "gone.jsonl"))).toBe(path.join(oldHome, "sessions", "gone.jsonl"));
  });

  it("removes temp links left by an interrupted run, and only those", () => {
    const {folder} = seedFleetcode();
    migrateDataHome(home);
    const leftover = path.join(folder, `.${UUID}.jsonl.agentyard-relink-4242`);
    fs.symlinkSync(path.join(newHome, "sessions", `${UUID}.jsonl`), leftover);
    const realLookalike = path.join(folder, `.notes.agentyard-relink-7`);
    fs.writeFileSync(realLookalike, "keep");
    const otherLink = path.join(folder, `.x.agentyard-relink-abc`);
    fs.symlinkSync("/somewhere", otherLink);
    expect(relinkTranscripts(home)).toEqual({relinked: 3, skipped: 0, cleaned: 1, errors: []});
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.readFileSync(realLookalike, "utf-8")).toBe("keep");
    expect(fs.readlinkSync(otherLink)).toBe("/somewhere");
    expect(fs.readFileSync(path.join(folder, `${UUID}.jsonl`), "utf-8")).toBe("line1\nline2\n");
  });

  it("collects per-entry errors, keeps going and leaves the failed link intact", () => {
    const {folder} = seedFleetcode();
    migrateDataHome(home);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFs: typeof fs = require("fs");
    const realRename = rawFs.renameSync;
    const spy = jest.spyOn(rawFs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(`${UUID}.jsonl`)) throw new Error("EIO");
      return realRename(from, to);
    });
    const res = relinkTranscripts(home);
    spy.mockRestore();
    expect(res.relinked).toBe(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("EIO");
    expect(fs.readlinkSync(path.join(folder, `${UUID}.jsonl`))).toBe(path.join(oldHome, "sessions", `${UUID}.jsonl`));
    expect(fs.readdirSync(folder).some(n => n.includes("agentyard-relink"))).toBe(false);
  });
});

describe("migrateUserData", () => {
  let appData: string;
  let oldDir: string;
  let newDir: string;
  const LEGACY_CONFIG = {
    projects: [{id: "__standalone__", name: "Others", dirs: ["/h/s"]}, {id: "p1", name: "Acme", dirs: ["/w/acme"]}],
    sessions: [{id: "s1", projectId: "p1"}],
    terminalSettings: {fontSize: 14},
  };

  beforeEach(() => {
    appData = path.join(home, ".config");
    oldDir = path.join(appData, "fleetcode");
    newDir = path.join(appData, "agentyard");
  });

  function seedUserData(): void {
    fs.mkdirSync(path.join(oldDir, "Local Storage", "leveldb"), {recursive: true});
    fs.writeFileSync(path.join(oldDir, "config.json"), JSON.stringify(LEGACY_CONFIG));
    fs.writeFileSync(path.join(oldDir, "Local Storage", "leveldb", "000003.log"), "ls");
    fs.writeFileSync(path.join(oldDir, "Preferences"), "{}");
    fs.symlinkSync("host-1234", path.join(oldDir, "SingletonLock"));
    fs.mkdirSync(path.join(oldDir, "Cache", "Cache_Data"), {recursive: true});
    fs.writeFileSync(path.join(oldDir, "Cache", "Cache_Data", "data_0"), "cache");
    fs.mkdirSync(path.join(oldDir, "GPUCache"));
  }

  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));
  const marker = () => path.join(newDir, USER_DATA_MARKER);

  it("is a no-op when there is no old folder", () => {
    expect(migrateUserData(oldDir, newDir)).toEqual({action: "none", warnings: []});
    expect(fs.existsSync(newDir)).toBe(false);
  });

  it("copies only the settings entries, writes the marker and keeps the old folder", () => {
    seedUserData();
    const mtime = fs.statSync(path.join(oldDir, "config.json")).mtimeMs;
    expect(migrateUserData(oldDir, newDir)).toEqual({action: "copied", warnings: []});
    expect(readJson(path.join(newDir, "config.json"))).toEqual(LEGACY_CONFIG);
    // utimes keeps millisecond precision
    expect(Math.abs(fs.statSync(path.join(newDir, "config.json")).mtimeMs - mtime)).toBeLessThan(1);
    expect(fs.readFileSync(path.join(newDir, "Local Storage", "leveldb", "000003.log"), "utf-8")).toBe("ls");
    expect(fs.readdirSync(newDir).sort()).toEqual([USER_DATA_MARKER, "Local Storage", "Preferences", "config.json"].sort());
    expect(readJson(path.join(oldDir, "config.json"))).toEqual(LEGACY_CONFIG);
    expect(fs.readdirSync(appData).sort()).toEqual(["agentyard", "fleetcode"]);
  });

  it("does nothing once the marker is present", () => {
    seedUserData();
    fs.mkdirSync(newDir, {recursive: true});
    fs.writeFileSync(marker(), "");
    expect(migrateUserData(oldDir, newDir)).toEqual({action: "none", warnings: []});
    expect(fs.readdirSync(newDir)).toEqual([USER_DATA_MARKER]);
  });

  it("is idempotent", () => {
    seedUserData();
    migrateUserData(oldDir, newDir);
    const before = fs.readFileSync(path.join(newDir, "config.json"), "utf-8");
    expect(migrateUserData(oldDir, newDir)).toEqual({action: "none", warnings: []});
    expect(fs.readFileSync(path.join(newDir, "config.json"), "utf-8")).toBe(before);
  });

  it("fills a present folder without overwriting its files", () => {
    seedUserData();
    fs.mkdirSync(path.join(newDir, "Local Storage", "leveldb"), {recursive: true});
    fs.writeFileSync(path.join(newDir, "Local Storage", "leveldb", "000003.log"), "new");
    fs.writeFileSync(path.join(oldDir, "Local Storage", "leveldb", "CURRENT"), "cur");
    expect(migrateUserData(oldDir, newDir).action).toBe("merged");
    expect(fs.readFileSync(path.join(newDir, "Local Storage", "leveldb", "000003.log"), "utf-8")).toBe("new");
    expect(fs.readFileSync(path.join(newDir, "Local Storage", "leveldb", "CURRENT"), "utf-8")).toBe("cur");
    expect(fs.existsSync(marker())).toBe(true);
  });

  it("retries after a failed first run and merges into the config written in between", () => {
    seedUserData();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFs: typeof fs = require("fs");
    const realCp = rawFs.cpSync;
    const spy = jest.spyOn(rawFs, "cpSync").mockImplementation((src, dst, opts) => {
      if (String(src).endsWith("config.json")) throw new Error("ENOENT: journal vanished");
      return realCp(src, dst, opts);
    });
    const first = migrateUserData(oldDir, newDir);
    spy.mockRestore();
    expect(first.action).toBe("failed");
    expect(first.warnings[0]).toContain("journal vanished");
    expect(fs.existsSync(marker())).toBe(false);
    expect(fs.existsSync(path.join(newDir, "config.json"))).toBe(false);
    expect(fs.readdirSync(newDir).some(n => n.includes(".migrating-"))).toBe(false);

    // the app started with an empty store and wrote its own config.json
    const fresh = {projects: [{id: "__standalone__", name: "Others", dirs: ["/h/new"]}], terminalSettings: {fontSize: 12}};
    fs.writeFileSync(path.join(newDir, "config.json"), JSON.stringify(fresh));

    expect(migrateUserData(oldDir, newDir)).toEqual({action: "merged", warnings: []});
    expect(readJson(path.join(newDir, "config.json"))).toEqual({
      projects: [fresh.projects[0], LEGACY_CONFIG.projects[1]],
      sessions: LEGACY_CONFIG.sessions,
      terminalSettings: {fontSize: 12},
    });
    expect(fs.existsSync(marker())).toBe(true);
  });

  it("copies config.json on the retry when the failed run wrote none", () => {
    seedUserData();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFs: typeof fs = require("fs");
    const spy = jest.spyOn(rawFs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EIO");
    });
    expect(migrateUserData(oldDir, newDir).action).toBe("failed");
    spy.mockRestore();
    expect(fs.existsSync(marker())).toBe(false);
    expect(migrateUserData(oldDir, newDir).action).toBe("copied");
    expect(readJson(path.join(newDir, "config.json"))).toEqual(LEGACY_CONFIG);
    expect(fs.existsSync(marker())).toBe(true);
  });

  it("legacyUserDataDir matches the new folder's naming, falling back to the other", () => {
    expect(legacyUserDataDir(appData, newDir)).toBe(oldDir);
    expect(legacyUserDataDir(appData, path.join(appData, "Agentyard"))).toBe(path.join(appData, "FleetCode"));
    fs.mkdirSync(oldDir, {recursive: true});
    expect(legacyUserDataDir(appData, path.join(appData, "Agentyard"))).toBe(oldDir);
  });
});

describe("mergeLegacyConfig", () => {
  it("keeps everything in current and adds what is missing from legacy", () => {
    const current = {
      projects: [{id: "a", name: "new A"}],
      sessions: [{id: "s1", name: "mine"}],
      hiddenTranscripts: ["u1"],
      terminalSettings: {fontSize: 12},
    };
    const legacy = {
      projects: [{id: "a", name: "old A"}, {id: "b", name: "B"}],
      sessions: [{id: "s1", name: "theirs"}, {id: "s2", name: "two"}],
      hiddenTranscripts: ["u1", "u2"],
      terminalSettings: {fontSize: 16},
      lastSessionConfig: {projectDir: "/w"},
    };
    expect(mergeLegacyConfig(current, legacy)).toEqual({
      projects: [{id: "a", name: "new A"}, {id: "b", name: "B"}],
      sessions: [{id: "s1", name: "mine"}, {id: "s2", name: "two"}],
      hiddenTranscripts: ["u1", "u2"],
      terminalSettings: {fontSize: 12},
      lastSessionConfig: {projectDir: "/w"},
    });
    expect(current.projects).toHaveLength(1); // input not mutated
  });

  it("is idempotent", () => {
    const legacy = {projects: [{id: "b"}], sessions: [{id: "s2"}], hiddenTranscripts: ["u2"]};
    const once = mergeLegacyConfig({projects: [{id: "a"}]}, legacy);
    expect(mergeLegacyConfig(once, legacy)).toEqual(once);
  });
});

describe("migrateScratchDir", () => {
  let oldScratch: string;
  let newScratch: string;
  let oldFolder: string;
  let newFolder: string;

  beforeEach(() => {
    oldScratch = path.join(home, "fleetcode-scratch");
    newScratch = path.join(home, "agentyard-scratch");
    oldFolder = path.join(projects, encodeProjectDir(oldScratch));
    newFolder = path.join(projects, encodeProjectDir(newScratch));
  });

  function seedScratch(): void {
    fs.mkdirSync(path.join(oldScratch, "notes"), {recursive: true});
    fs.writeFileSync(path.join(oldScratch, "notes", "a.txt"), "scratch");
    fs.mkdirSync(path.join(oldFolder, "memory"), {recursive: true});
    fs.writeFileSync(path.join(oldFolder, "memory", "MEMORY.md"), "mem");
  }

  it("is a no-op on a fresh install", () => {
    expect(migrateScratchDir(home)).toEqual({action: "none", warnings: []});
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("moves the folder, leaves a compatibility link and moves Claude's project folder", () => {
    seedScratch();
    expect(migrateScratchDir(home)).toEqual({action: "renamed+transcripts-moved", warnings: []});
    expect(fs.lstatSync(newScratch).isDirectory()).toBe(true);
    expect(fs.readlinkSync(oldScratch)).toBe(newScratch);
    expect(fs.readFileSync(path.join(oldScratch, "notes", "a.txt"), "utf-8")).toBe("scratch");
    expect(fs.existsSync(oldFolder)).toBe(false);
    expect(fs.readFileSync(path.join(newFolder, "memory", "MEMORY.md"), "utf-8")).toBe("mem");
  });

  it("is idempotent", () => {
    seedScratch();
    migrateScratchDir(home);
    const after = snapshot(home);
    expect(migrateScratchDir(home)).toEqual({action: "none", warnings: []});
    expect(snapshot(home)).toEqual(after);
  });

  it("changes nothing and warns when both scratch folders exist", () => {
    seedScratch();
    fs.mkdirSync(newScratch);
    const before = snapshot(home);
    const res = migrateScratchDir(home);
    expect(res.action).toBe("both-exist");
    expect(res.warnings).toHaveLength(1);
    expect(snapshot(home)).toEqual(before);
  });

  it("leaves both project folders and warns when both exist", () => {
    seedScratch();
    fs.mkdirSync(newFolder, {recursive: true});
    const res = migrateScratchDir(home);
    expect(res.action).toBe("renamed");
    expect(res.warnings[0]).toContain("not moving the Others transcripts folder");
    expect(fs.existsSync(path.join(oldFolder, "memory", "MEMORY.md"))).toBe(true);
    expect(fs.readdirSync(newFolder)).toEqual([]);
  });

  it("does nothing when the old path is a link elsewhere", () => {
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, oldScratch, "dir");
    fs.mkdirSync(oldFolder, {recursive: true});
    expect(migrateScratchDir(home)).toEqual({action: "none", warnings: []});
    expect(fs.readlinkSync(oldScratch)).toBe(elsewhere);
    expect(fs.existsSync(oldFolder)).toBe(true);
    expect(fs.existsSync(newScratch)).toBe(false);
  });
});

describe("rewriteScratchPaths", () => {
  const OLD = "/h/fleetcode-scratch";
  const NEW = "/h/agentyard-scratch";
  const config = {
    projects: [
      {id: "__standalone__", name: "Others", dirs: [OLD]},
      {id: "p1", name: "Acme", dirs: ["/w/acme", `${OLD}/sub`, "/h/fleetcode-scratch2"]},
    ],
    sessions: [
      {id: "s1", config: {projectDir: OLD, sessionType: "local"}, linkedDir: OLD},
      {id: "s2", config: {projectDir: "/w/acme"}, linkedDir: "/w/acme", worktreePath: OLD},
      {id: "s3", config: {projectDir: `${OLD}/sub`}},
    ],
    lastSessionConfig: {projectDir: OLD, parentBranch: "main"},
    terminalSettings: {worktreeDir: OLD},
  };

  it("replaces exact matches in the known fields only", () => {
    const {config: out, changed} = rewriteScratchPaths(config, OLD, NEW);
    expect(changed).toBe(true);
    expect(out).toEqual({
      projects: [
        {id: "__standalone__", name: "Others", dirs: [NEW]},
        {id: "p1", name: "Acme", dirs: ["/w/acme", `${OLD}/sub`, "/h/fleetcode-scratch2"]},
      ],
      sessions: [
        {id: "s1", config: {projectDir: NEW, sessionType: "local"}, linkedDir: NEW},
        {id: "s2", config: {projectDir: "/w/acme"}, linkedDir: "/w/acme", worktreePath: OLD},
        {id: "s3", config: {projectDir: `${OLD}/sub`}},
      ],
      lastSessionConfig: {projectDir: NEW, parentBranch: "main"},
      terminalSettings: {worktreeDir: OLD},
    });
    expect(config.projects[0].dirs).toEqual([OLD]); // input not mutated
  });

  it("is idempotent", () => {
    const once = rewriteScratchPaths(config, OLD, NEW).config;
    const twice = rewriteScratchPaths(once, OLD, NEW);
    expect(twice.changed).toBe(false);
    expect(twice.config).toEqual(once);
  });

  it("keeps a config without matches as is", () => {
    const plain = {projects: [{id: "p", dirs: ["/w"]}], sessions: [{id: "s"}]};
    expect(rewriteScratchPaths(plain, OLD, NEW)).toEqual({config: plain, changed: false});
  });
});

describe("migrateConfigScratchPaths", () => {
  let userData: string;
  const write = (cfg: object) => fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(cfg, null, "\t"));
  const read = () => JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf-8"));

  beforeEach(() => {
    userData = path.join(home, ".config", "agentyard");
    fs.mkdirSync(userData, {recursive: true});
  });

  it("rewrites the stored path once the folder was migrated", () => {
    fs.mkdirSync(path.join(home, "fleetcode-scratch"));
    migrateScratchDir(home);
    write({projects: [{id: "__standalone__", dirs: [path.join(home, "fleetcode-scratch")]}]});
    expect(migrateConfigScratchPaths(home, userData)).toEqual({action: "rewritten", warnings: []});
    expect(read().projects[0].dirs).toEqual([path.join(home, "agentyard-scratch")]);
    expect(migrateConfigScratchPaths(home, userData)).toEqual({action: "none", warnings: []});
    expect(fs.readdirSync(userData)).toEqual(["config.json"]);
  });

  it("does not rewrite while the old folder is still a real directory", () => {
    fs.mkdirSync(path.join(home, "fleetcode-scratch"));
    fs.mkdirSync(path.join(home, "agentyard-scratch"));
    const cfg = {projects: [{id: "__standalone__", dirs: [path.join(home, "fleetcode-scratch")]}]};
    write(cfg);
    expect(migrateConfigScratchPaths(home, userData)).toEqual({action: "none", warnings: []});
    expect(read()).toEqual(cfg);
  });

  it("is a no-op without config.json", () => {
    expect(migrateConfigScratchPaths(home, userData)).toEqual({action: "none", warnings: []});
  });
});

describe("runDataMigration", () => {
  it("is a no-op on a fresh install", () => {
    const res = runDataMigration({
      home,
      oldUserData: path.join(home, ".config", "fleetcode"),
      newUserData: path.join(home, ".config", "agentyard"),
    });
    expect(res.warnings).toEqual([]);
    expect(res.summary).toBe("settings: none, data folder: none, others folder: none, config paths: none, links relinked: 0, skipped: 0, cleaned: 0, errors: 0");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("migrates everything in one go, scratch transcripts included, and is idempotent", () => {
    const {folder} = seedFleetcode();
    // Others sessions: scratch folder + Claude folder with central links and memory/
    const oldScratch = path.join(home, "fleetcode-scratch");
    const newScratch = path.join(home, "agentyard-scratch");
    fs.mkdirSync(oldScratch);
    const scratchFolder = path.join(projects, encodeProjectDir(oldScratch));
    const SCRATCH_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const sessions = path.join(oldHome, "sessions");
    fs.mkdirSync(path.join(sessions, SCRATCH_UUID));
    fs.writeFileSync(path.join(sessions, `${SCRATCH_UUID}.jsonl`), "scratch talk\n");
    fs.mkdirSync(path.join(scratchFolder, "memory"), {recursive: true});
    fs.symlinkSync(path.join(sessions, `${SCRATCH_UUID}.jsonl`), path.join(scratchFolder, `${SCRATCH_UUID}.jsonl`));
    fs.symlinkSync(path.join(sessions, SCRATCH_UUID), path.join(scratchFolder, SCRATCH_UUID), "dir");

    const oldUserData = path.join(home, ".config", "fleetcode");
    const newUserData = path.join(home, ".config", "agentyard");
    fs.mkdirSync(oldUserData, {recursive: true});
    fs.writeFileSync(
      path.join(oldUserData, "config.json"),
      JSON.stringify({
        projects: [{id: "__standalone__", name: "Others", dirs: [oldScratch]}],
        sessions: [{id: "s1", config: {projectDir: oldScratch}, linkedDir: oldScratch}],
        lastSessionConfig: {projectDir: oldScratch},
      }),
    );

    const res = runDataMigration({home, oldUserData, newUserData});
    expect(res.warnings).toEqual([]);
    expect(res.summary).toBe(
      "settings: copied, data folder: renamed, others folder: renamed+transcripts-moved, config paths: rewritten, " +
        "links relinked: 5, skipped: 0, cleaned: 0, errors: 0",
    );
    expect(fs.readFileSync(path.join(folder, UUID, "subagents", "a.jsonl"), "utf-8")).toBe("sub");
    const newScratchFolder = path.join(projects, encodeProjectDir(newScratch));
    expect(fs.readlinkSync(path.join(newScratchFolder, `${SCRATCH_UUID}.jsonl`))).toBe(
      path.join(newHome, "sessions", `${SCRATCH_UUID}.jsonl`),
    );
    expect(fs.readlinkSync(path.join(newScratchFolder, SCRATCH_UUID))).toBe(path.join(newHome, "sessions", SCRATCH_UUID));
    expect(fs.readFileSync(path.join(newScratchFolder, `${SCRATCH_UUID}.jsonl`), "utf-8")).toBe("scratch talk\n");
    expect(fs.lstatSync(path.join(newScratchFolder, "memory")).isDirectory()).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(newUserData, "config.json"), "utf-8"));
    expect(cfg.projects[0].dirs).toEqual([newScratch]);
    expect(cfg.sessions[0].config.projectDir).toBe(newScratch);
    expect(cfg.sessions[0].linkedDir).toBe(newScratch);
    expect(cfg.lastSessionConfig.projectDir).toBe(newScratch);
    // the legacy settings stay as they were
    expect(JSON.parse(fs.readFileSync(path.join(oldUserData, "config.json"), "utf-8")).projects[0].dirs).toEqual([oldScratch]);

    const after = snapshot(home);
    const second = runDataMigration({home, oldUserData, newUserData});
    expect(second.warnings).toEqual([]);
    expect(second.summary).toBe(
      "settings: none, data folder: already-migrated, others folder: none, config paths: none, " +
        "links relinked: 0, skipped: 0, cleaned: 0, errors: 0",
    );
    expect(snapshot(home)).toEqual(after);
  });

  it("reports both-exist as a warning and relinks nothing", () => {
    seedFleetcode();
    fs.mkdirSync(newHome);
    const before = snapshot(home);
    const res = runDataMigration({
      home,
      oldUserData: path.join(home, ".config", "fleetcode"),
      newUserData: path.join(home, ".config", "agentyard"),
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.summary).toContain("data folder: both-exist");
    expect(res.summary).toContain("links relinked: 0");
    expect(snapshot(home)).toEqual(before);
  });
});
