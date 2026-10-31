import { buildSidebar, buildStandaloneGroup, filterSidebarGroup } from "./sidebar-model";
import { STANDALONE_PROJECT_ID } from "./project-model";
import { PersistedSession, Project, SessionStatus, SessionType } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const project: Project = { id: "g", name: "acme", dirs: ["/w/acme1"] };

function s(id: string, extra: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    number: 1,
    name: id,
    config: { projectDir: "/w/acme1", sessionType: SessionType.LOCAL, codingAgent: "claude" },
    createdAt: NOW - 30 * DAY,
    sessionUuid: "u" + id,
    projectId: "g",
    ...extra,
  } as PersistedSession;
}

describe("buildSidebar", () => {
  it("sorts by activity and splits older", () => {
    const sessions = [
      s("old", { lastActivity: NOW - 8 * DAY, status: SessionStatus.IDLE }),
      s("new", { lastActivity: NOW - 1 * DAY, status: SessionStatus.IDLE }),
      s("mid", { createdAt: NOW - 3 * DAY }),
    ];
    const [group] = buildSidebar([project], sessions, NOW);
    expect(group.recent.map(x => x.id)).toEqual(["new", "mid"]);
    expect(group.older.map(x => x.id)).toEqual(["old"]);
  });

  it("waiting and done sessions never go to older", () => {
    const sessions = [
      s("w", { lastActivity: NOW - 20 * DAY, status: SessionStatus.WAITING }),
      s("d", { lastActivity: NOW - 20 * DAY, status: SessionStatus.DONE }),
      s("r", { lastActivity: NOW - 20 * DAY, status: SessionStatus.RUNNING }),
    ];
    const [group] = buildSidebar([project], sessions, NOW);
    expect(group.older).toEqual([]);
    expect(group.recent).toHaveLength(3);
  });

  it("waitingCount counts waiting and done", () => {
    const sessions = [
      s("w", { status: SessionStatus.WAITING }),
      s("d", { status: SessionStatus.DONE }),
      s("r", { status: SessionStatus.RUNNING }),
      s("i", { status: SessionStatus.IDLE }),
    ];
    expect(buildSidebar([project], sessions, NOW)[0].waitingCount).toBe(2);
  });

  it("sorts projects by name, keeps empty projects, omits orphan sessions", () => {
    const projects: Project[] = [
      { id: "z", name: "zeta", dirs: [] },
      { id: "g", name: "alpha", dirs: [] },
    ];
    const groups = buildSidebar(projects, [s("o", { projectId: "missing" })], NOW);
    expect(groups.map(g => g.project.name)).toEqual(["alpha", "zeta"]);
    expect(groups.every(g => g.recent.length === 0 && g.older.length === 0)).toBe(true);
  });

  it("honours custom staleDays", () => {
    const sessions = [s("a", { lastActivity: NOW - 2 * DAY, status: SessionStatus.IDLE })];
    expect(buildSidebar([project], sessions, NOW, 1)[0].older).toHaveLength(1);
  });
});

describe("standalone project", () => {
  const standalone: Project = { id: STANDALONE_PROJECT_ID, name: "Others", dirs: ["/h/agentyard-scratch"] };

  it("buildSidebar leaves the standalone project out of the project groups", () => {
    const sessions = [s("a"), s("b", { projectId: STANDALONE_PROJECT_ID })];
    const groups = buildSidebar([standalone, project], sessions, NOW);
    expect(groups.map(g => g.project.id)).toEqual(["g"]);
    expect([...groups[0].recent, ...groups[0].older].map(x => x.id)).toEqual(["a"]);
  });

  it("buildStandaloneGroup holds only standalone sessions with older split and waiting count", () => {
    const sessions = [
      s("a"),
      s("w", { projectId: STANDALONE_PROJECT_ID, status: SessionStatus.WAITING }),
      s("old", { projectId: STANDALONE_PROJECT_ID, lastActivity: NOW - 9 * DAY, status: SessionStatus.IDLE }),
    ];
    const group = buildStandaloneGroup([project, standalone], sessions, NOW);
    expect(group?.project.id).toBe(STANDALONE_PROJECT_ID);
    expect(group?.recent.map(x => x.id)).toEqual(["w"]);
    expect(group?.older.map(x => x.id)).toEqual(["old"]);
    expect(group?.waitingCount).toBe(1);
  });

  it("buildStandaloneGroup is undefined while the standalone project is missing", () => {
    expect(buildStandaloneGroup([project], [s("a")], NOW)).toBeUndefined();
  });
});

describe("filterSidebarGroup", () => {
  const group = {
    project,
    waitingCount: 1,
    recent: [s("a", { name: "BİLGİ ekranı" }), s("b", { name: "Release check" })],
    older: [s("c", { name: "İndirim kuralları" }), s("d", { name: "Cluster feature" })],
  };

  it("returns the group unchanged for an empty or blank query", () => {
    expect(filterSidebarGroup(group, "")).toBe(group);
    expect(filterSidebarGroup(group, "   ")).toBe(group);
  });

  it("matches names case-insensitively with Turkish casing and lists older matches inline", () => {
    const r = filterSidebarGroup(group, "bilgi");
    expect(r.recent.map(x => x.id)).toEqual(["a"]);
    expect(r.older).toEqual([]);
    expect(filterSidebarGroup(group, "İNDİRİM").recent.map(x => x.id)).toEqual(["c"]);
    expect(filterSidebarGroup(group, "e").recent.map(x => x.id)).toEqual(["a", "b", "d"]);
  });

  it("keeps the waiting counter of the whole group", () => {
    expect(filterSidebarGroup(group, "zzz")).toEqual({ ...group, recent: [], older: [] });
  });
});
