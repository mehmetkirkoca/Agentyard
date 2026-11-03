import {createPaneState, PaneNode, PaneState, showSession, visibleSessions} from "./pane-layout";
import {
  activeWorkspace,
  addWorkspace,
  createWorkspaceState,
  DEFAULT_WORKSPACE_ID,
  deleteWorkspace,
  forgetSession,
  moveSessionTo,
  nextWorkspaceName,
  parseWorkspaceState,
  pruneWorkspaces,
  removeSessionFromWorkspaces,
  renameWorkspace,
  setSidebarFilter,
  showsInSidebar,
  switchWorkspace,
  waitingByWorkspace,
  withActivePanes,
  WorkspaceState,
  workspaceOf,
} from "./workspace-model";

const L = (id: number, session: string | null = null, pinned = false): PaneNode =>
  pinned ? {kind: "leaf", id, session, pinned: true} : {kind: "leaf", id, session};
const S = (a: PaneNode, b: PaneNode): PaneNode => ({kind: "split", dir: "row", ratio: 0.5, a, b});
const panes = (root: PaneNode, tabOrder: string[] = []): PaneState => ({...createPaneState(), root, tabOrder});

// Default + "w2" (Backend) with "a" shown in w2's pane; Default active again
function withAInBackgroundW2(): WorkspaceState {
  let s = moveSessionTo(addWorkspace(createWorkspaceState(), "w2", "Backend"), "a", "w2");
  s = withActivePanes(s, showSession(activeWorkspace(s).panes, "a"));
  return switchWorkspace(s, DEFAULT_WORKSPACE_ID);
}

describe("workspaces", () => {
  it("starts with a single Default workspace holding the given panes", () => {
    const p = panes(L(1, "a"), ["a"]);
    const s = createWorkspaceState(p);
    expect(s.workspaces).toEqual([{id: "default", name: "Default", panes: p}]);
    expect(s.activeId).toBe("default");
    expect(s.membership).toEqual({});
    expect(s.sidebarFilter).toBe(false);
  });

  it("adds a workspace with empty panes and makes it active", () => {
    const s = addWorkspace(createWorkspaceState(), "w2", "Backend");
    expect(s.workspaces.map(w => w.name)).toEqual(["Default", "Backend"]);
    expect(s.activeId).toBe("w2");
    expect(visibleSessions(activeWorkspace(s).panes)).toEqual([]);
  });

  it("refuses a duplicate id", () => {
    const s = addWorkspace(createWorkspaceState(), "w2", "Backend");
    expect(addWorkspace(s, "w2", "Other")).toBe(s);
  });

  it("names new workspaces with the first free number", () => {
    let s = createWorkspaceState();
    expect(nextWorkspaceName(s)).toBe("Workspace 2");
    s = addWorkspace(s, "w2", "Workspace 2");
    expect(nextWorkspaceName(s)).toBe("Workspace 3");
  });

  it("renames with trimming; empty names and unknown ids change nothing", () => {
    const s = createWorkspaceState();
    expect(renameWorkspace(s, "default", "  Main ").workspaces[0].name).toBe("Main");
    expect(renameWorkspace(s, "default", "   ")).toBe(s);
    expect(renameWorkspace(s, "nope", "X")).toBe(s);
  });

  it("switches the active workspace; unknown or same ids change nothing", () => {
    const s = addWorkspace(createWorkspaceState(), "w2", "Backend");
    expect(switchWorkspace(s, "default").activeId).toBe("default");
    expect(switchWorkspace(s, "w2")).toBe(s);
    expect(switchWorkspace(s, "nope")).toBe(s);
  });

  it("writes the active workspace's panes back", () => {
    const s = createWorkspaceState();
    const p = panes(L(1, "x"));
    expect(activeWorkspace(withActivePanes(s, p)).panes).toBe(p);
  });
});

describe("deleteWorkspace", () => {
  it("never deletes Default or an unknown workspace", () => {
    const s = addWorkspace(createWorkspaceState(), "w2", "Backend");
    expect(deleteWorkspace(s, "default")).toBe(s);
    expect(deleteWorkspace(s, "nope")).toBe(s);
  });

  it("deleting the active workspace moves members and open tabs to Default and activates it", () => {
    let s = addWorkspace(createWorkspaceState(), "w2", "Backend");
    s = moveSessionTo(s, "a", "w2");
    s = deleteWorkspace(s, "w2");
    expect(s.activeId).toBe("default");
    expect(s.workspaces.map(w => w.id)).toEqual(["default"]);
    expect(s.membership).toEqual({a: "default"});
    expect(activeWorkspace(s).panes.tabOrder).toEqual(["a"]);
  });

  it("keeps Default's pane tree and the active workspace when a background one is deleted", () => {
    let s = createWorkspaceState(panes(L(1, "d"), ["d"]));
    s = moveSessionTo(addWorkspace(s, "w2", "Backend"), "a", "w2");
    s = addWorkspace(s, "w3", "Review");
    s = deleteWorkspace(s, "w2");
    expect(s.activeId).toBe("w3");
    expect(visibleSessions(s.workspaces[0].panes)).toEqual(["d"]);
    expect(s.workspaces[0].panes.tabOrder).toEqual(["d", "a"]);
  });
});

describe("membership", () => {
  it("records the workspace a session joins", () => {
    const s = moveSessionTo(createWorkspaceState(), "a", "default");
    expect(workspaceOf(s, "a")).toBe("default");
    expect(workspaceOf(s, "b")).toBeNull();
    expect(activeWorkspace(s).panes.tabOrder).toEqual(["a"]);
  });

  it("moving a session evicts it from the other workspaces and lifts its pin", () => {
    let s = createWorkspaceState(panes(S(L(1, "a", true), L(2, "b")), ["a", "b"]));
    s = moveSessionTo(addWorkspace(s, "w2", "Backend"), "a", "w2");
    const def = s.workspaces[0].panes;
    expect(visibleSessions(def)).toEqual(["b"]);
    expect(def.tabOrder).toEqual(["b"]);
    expect(def.root.kind === "split" && def.root.a.kind === "leaf" && def.root.a.pinned).toBeFalsy();
    expect(s.workspaces[1].panes.tabOrder).toEqual(["a"]);
    expect(visibleSessions(s.workspaces[1].panes)).toEqual([]);
    expect(workspaceOf(s, "a")).toBe("w2");
  });

  it("ignores a move to an unknown workspace", () => {
    const s = createWorkspaceState();
    expect(moveSessionTo(s, "a", "nope")).toBe(s);
  });

  it("a session closed in a background workspace leaves that workspace's panes but keeps its record", () => {
    const s = removeSessionFromWorkspaces(withAInBackgroundW2(), "a", []);
    expect(visibleSessions(s.workspaces[1].panes)).toEqual([]);
    expect(workspaceOf(s, "a")).toBe("w2");
  });

  it("a session closed in the active workspace refills the focused pane from the open tabs", () => {
    let s = createWorkspaceState(panes(L(1, "a"), ["a", "b"]));
    s = moveSessionTo(moveSessionTo(s, "a", "default"), "b", "default");
    s = removeSessionFromWorkspaces(s, "a", ["b"]);
    expect(visibleSessions(activeWorkspace(s).panes)).toEqual(["b"]);
    expect(workspaceOf(s, "a")).toBe("default");
  });

  it("forgetting a deleted session drops its record and its panes", () => {
    const s = forgetSession(withAInBackgroundW2(), "a");
    expect(workspaceOf(s, "a")).toBeNull();
    expect(visibleSessions(s.workspaces[1].panes)).toEqual([]);
  });

  it("prunes unknown sessions from records and every workspace's panes", () => {
    const s = pruneWorkspaces(withAInBackgroundW2(), new Set(["b"]));
    expect(s.membership).toEqual({});
    expect(visibleSessions(s.workspaces[1].panes)).toEqual([]);
  });
});

describe("sidebar filter", () => {
  it("shows everything while off", () => {
    const s = switchWorkspace(withAInBackgroundW2(), "default");
    expect(showsInSidebar(s, "a")).toBe(true);
  });

  it("shows only the active workspace's sessions; unrecorded ones count as Default", () => {
    let s = setSidebarFilter(withAInBackgroundW2(), true);
    expect(s.sidebarFilter).toBe(true);
    expect(showsInSidebar(s, "a")).toBe(false);
    expect(showsInSidebar(s, "never-opened")).toBe(true);
    s = switchWorkspace(s, "w2");
    expect(showsInSidebar(s, "a")).toBe(true);
    expect(showsInSidebar(s, "never-opened")).toBe(false);
  });

  it("counts waiting sessions per workspace", () => {
    const counts = waitingByWorkspace(withAInBackgroundW2(), ["a", "x"]);
    expect([...counts.entries()]).toEqual([["w2", 1], ["default", 1]]);
  });
});

describe("parseWorkspaceState", () => {
  const legacy = {root: {kind: "leaf", id: 1, session: "a"}, focused: 1, tabOrder: ["a"], linkedSplits: true};

  it("migrates the legacy pane layout into a single Default workspace", () => {
    const s = parseWorkspaceState(null, legacy);
    expect(s.workspaces).toHaveLength(1);
    expect(visibleSessions(s.workspaces[0].panes)).toEqual(["a"]);
    expect(s.membership).toEqual({});
  });

  it("round-trips a stored state", () => {
    const stored = setSidebarFilter(switchWorkspace(withAInBackgroundW2(), "w2"), true);
    const s = parseWorkspaceState(JSON.parse(JSON.stringify(stored)), null);
    expect(s.workspaces.map(w => [w.id, w.name])).toEqual([["default", "Default"], ["w2", "Backend"]]);
    expect(s.activeId).toBe("w2");
    expect(s.sidebarFilter).toBe(true);
    expect(s.membership).toEqual({a: "w2"});
    expect(visibleSessions(s.workspaces[1].panes)).toEqual(["a"]);
  });

  it("repairs a stored state: garbage entries, missing Default, a session in two workspaces", () => {
    const leafA = {kind: "leaf", id: 1, session: "a"};
    const raw = {
      workspaces: [
        {id: "w2", name: "Backend", panes: {root: leafA, focused: 1, tabOrder: ["a"]}},
        {id: "", name: "x"},
        {id: "w2", name: "dup"},
        "junk",
        {id: "w3", name: "Review", panes: {root: leafA, focused: 1, tabOrder: ["a"]}},
      ],
      activeId: "gone",
      membership: {a: "w3", b: "gone", c: 5},
      sidebarFilter: "yes",
    };
    const s = parseWorkspaceState(raw, legacy);
    expect(s.workspaces.map(w => w.id)).toEqual(["default", "w2", "w3"]);
    expect(visibleSessions(s.workspaces[0].panes)).toEqual([]);
    expect(s.activeId).toBe("default");
    expect(s.membership).toEqual({a: "w3", b: "default"});
    expect(s.sidebarFilter).toBe(false);
    expect(visibleSessions(s.workspaces[1].panes)).toEqual([]);
    expect(s.workspaces[1].panes.tabOrder).toEqual([]);
    expect(visibleSessions(s.workspaces[2].panes)).toEqual(["a"]);
  });

  it("moves a stored Default to the front", () => {
    const raw = {workspaces: [{id: "w2", name: "B"}, {id: "default", name: "Main"}], activeId: "w2", membership: {}};
    const s = parseWorkspaceState(raw, null);
    expect(s.workspaces.map(w => w.name)).toEqual(["Main", "B"]);
  });

  it("falls back to the legacy layout for garbage", () => {
    expect(parseWorkspaceState("nope", legacy).workspaces).toHaveLength(1);
    expect(parseWorkspaceState({workspaces: "x"}, null).workspaces[0].id).toBe("default");
  });
});
