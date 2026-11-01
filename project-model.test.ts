import {
  assignProjects,
  canAddDir,
  ensureStandaloneProject,
  isStandaloneProject,
  STANDALONE_PROJECT_ID,
  standaloneScratchDir,
  computeDirOccupancy,
  filterRepoCandidates,
  normalizeDirs,
  findProjectForDir,
  firstFreeDir,
} from "./project-model";
import { PersistedSession, Project, SessionType } from "./types";

function makeSession(id: string, projectDir: string, extra: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    number: 1,
    name: id,
    config: { projectDir, sessionType: SessionType.LOCAL, codingAgent: "claude" },
    createdAt: 1,
    sessionUuid: "uuid-" + id,
    ...extra,
  } as PersistedSession;
}

function counter(): () => string {
  let n = 0;
  return () => "p" + ++n;
}

describe("assignProjects", () => {
  it("attaches to existing project and creates single-dir project otherwise", () => {
    const projects: Project[] = [{ id: "g", name: "acme", dirs: ["/w/acme1", "/w/acme2"] }];
    const sessions = [makeSession("a", "/w/acme2"), makeSession("b", "/w/other")];
    const result = assignProjects(sessions, projects, counter());

    expect(result.sessions[0].projectId).toBe("g");
    expect(result.sessions[1].projectId).toBe("p1");
    expect(result.projects).toEqual([
      { id: "g", name: "acme", dirs: ["/w/acme1", "/w/acme2"] },
      { id: "p1", name: "other", dirs: ["/w/other"] },
    ]);
  });

  it("keeps already assigned sessions", () => {
    const projects: Project[] = [{ id: "g", name: "acme", dirs: ["/w/acme1"] }];
    const sessions = [makeSession("a", "/w/zzz", { projectId: "g", linkedDir: "/w/acme1" })];
    const result = assignProjects(sessions, projects, counter());

    expect(result.sessions[0].projectId).toBe("g");
    expect(result.sessions[0].linkedDir).toBe("/w/acme1");
    expect(result.projects).toHaveLength(1);
  });

  it("sets linkedDir for local claude sessions only and does not mutate inputs", () => {
    const projects: Project[] = [];
    const local = makeSession("a", "/w/x");
    const worktree = makeSession("b", "/w/x", {
      config: { projectDir: "/w/x", sessionType: SessionType.WORKTREE, codingAgent: "claude" },
    } as Partial<PersistedSession>);
    const other = makeSession("c", "/w/x", {
      config: { projectDir: "/w/x", sessionType: SessionType.LOCAL, codingAgent: "codex" },
    } as Partial<PersistedSession>);
    const gemini = makeSession("d", "/w/x", {
      config: { projectDir: "/w/x", sessionType: SessionType.LOCAL, codingAgent: "gemini" },
    } as Partial<PersistedSession>);
    const snapshot = JSON.stringify([[local, worktree, other, gemini], projects]);
    const result = assignProjects([local, worktree, other, gemini], projects, counter());

    expect(result.sessions[0].linkedDir).toBe("/w/x");
    expect(result.sessions[1].linkedDir).toBeUndefined();
    expect(result.sessions[2].linkedDir).toBeUndefined();
    expect(result.sessions[3].linkedDir).toBeUndefined();
    expect(result.sessions.map(s => s.projectId)).toEqual(["p1", "p1", "p1", "p1"]);
    expect(result.projects).toHaveLength(1);
    expect(JSON.stringify([[local, worktree, other, gemini], projects])).toBe(snapshot);
  });
});

describe("findProjectForDir / canAddDir", () => {
  const projects: Project[] = [
    { id: "g", name: "acme", dirs: ["/w/acme1"] },
    { id: "h", name: "hub", dirs: ["/w/hub"] },
  ];

  it("finds project by exact resolved dir", () => {
    expect(findProjectForDir(projects, "/w/acme1/")?.id).toBe("g");
    expect(findProjectForDir(projects, "/w/acme10")).toBeUndefined();
  });

  it("canAddDir rejects dir owned by another project", () => {
    expect(canAddDir(projects, "h", "/w/acme1")).toEqual({ ok: false, reason: "already in project acme" });
    expect(canAddDir(projects, "h", "/w/new")).toEqual({ ok: true });
  });
});

describe("filterRepoCandidates", () => {
  it("natural sorts acme1..acme11 and drops non-git acme", () => {
    const entries = [
      { name: "acme", isGitRepo: false },
      { name: "acme1", isGitRepo: true },
      { name: "acme10", isGitRepo: true },
      { name: "acme2", isGitRepo: true },
      { name: "acme_deploy", isGitRepo: true },
      { name: "other", isGitRepo: true },
    ];
    expect(filterRepoCandidates(entries, "acme")).toEqual(["acme1", "acme2", "acme10", "acme_deploy"]);
  });
});

describe("computeDirOccupancy", () => {
  it("marks external cwd inside subdirectory", () => {
    const occ = computeDirOccupancy(["/w/acme1", "/w/acme2"], [], [{ pid: 1, cwd: "/w/acme1/web/src" }]);
    expect(occ["/w/acme1"]).toEqual({ kind: "external" });
    expect(occ["/w/acme2"]).toEqual({ kind: "free" });
  });

  it("does not match a sibling dir sharing a prefix", () => {
    const occ = computeDirOccupancy(["/w/acme1"], [], [{ pid: 1, cwd: "/w/acme10/src" }, { pid: 2, cwd: "/w/acme10" }]);
    expect(occ["/w/acme1"]).toEqual({ kind: "free" });
  });

  it("agentyard occupancy wins over external", () => {
    const occ = computeDirOccupancy(
      ["/w/acme1"],
      [{ sessionId: "s", sessionName: "Fix", dir: "/w/acme1" }],
      [{ pid: 1, cwd: "/w/acme1" }],
    );
    expect(occ["/w/acme1"]).toEqual({ kind: "agentyard", sessionId: "s", sessionName: "Fix" });
  });
});

describe("firstFreeDir", () => {
  it("skips occupied", () => {
    const occ = { "/a": { kind: "external" as const }, "/b": { kind: "free" as const } };
    expect(firstFreeDir(["/a", "/b"], occ)).toBe("/b");
    expect(firstFreeDir(["/a"], occ)).toBeUndefined();
  });
});

describe("normalizeDirs", () => {
  it("strips trailing slashes and dedups preserving first-seen order", () => {
    expect(normalizeDirs(["/b/", "/a", "/b", "/a/"])).toEqual(["/b", "/a"]);
  });

  it("resolves dot segments", () => {
    expect(normalizeDirs(["/a/x/../y"])).toEqual(["/a/y"]);
  });
});

describe("standalone project", () => {
  const HOME = "/h";
  const SCRATCH = "/h/agentyard-scratch";

  it("uses a fixed id and recognises it by project or id", () => {
    expect(STANDALONE_PROJECT_ID).toBe("__standalone__");
    expect(isStandaloneProject({ id: "__standalone__" })).toBe(true);
    expect(isStandaloneProject("__standalone__")).toBe(true);
    expect(isStandaloneProject({ id: "g" })).toBe(false);
    expect(isStandaloneProject(undefined)).toBe(false);
    expect(standaloneScratchDir(HOME)).toBe(SCRATCH);
  });

  it("appends the built-in project with the scratch dir when missing, without mutating input", () => {
    const projects: Project[] = [{ id: "g", name: "acme", dirs: ["/w/acme1"] }];
    const snapshot = JSON.stringify(projects);
    const result = ensureStandaloneProject(projects, HOME);
    expect(result.changed).toBe(true);
    expect(result.projects).toEqual([
      { id: "g", name: "acme", dirs: ["/w/acme1"] },
      { id: STANDALONE_PROJECT_ID, name: "Others", dirs: [SCRATCH] },
    ]);
    expect(JSON.stringify(projects)).toBe(snapshot);
  });

  it("is idempotent and keeps user-edited dirs", () => {
    const projects: Project[] = [{ id: STANDALONE_PROJECT_ID, name: "Others", dirs: ["/w/tmp", SCRATCH] }];
    const result = ensureStandaloneProject(projects, HOME);
    expect(result.changed).toBe(false);
    expect(result.projects).toBe(projects);
  });

  it("repairs a renamed or emptied built-in project", () => {
    const projects: Project[] = [{ id: STANDALONE_PROJECT_ID, name: "Other", dirs: [] }];
    const result = ensureStandaloneProject(projects, HOME);
    expect(result.changed).toBe(true);
    expect(result.projects).toEqual([{ id: STANDALONE_PROJECT_ID, name: "Others", dirs: [SCRATCH] }]);
    expect(projects[0].name).toBe("Other");
  });
});
