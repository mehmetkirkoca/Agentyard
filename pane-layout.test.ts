import {
  applyTemplate,
  assignSession,
  canAssign,
  clampSplit,
  closePane,
  createPaneState,
  crossHandle,
  dropZone,
  ensureInTabOrder,
  focusedSession,
  focusPane,
  is2x2,
  leaves,
  MAX_PANES,
  movePane,
  moveTab,
  PaneNode,
  paneRects,
  PaneState,
  parsePaneState,
  pruneSessions,
  removeSession,
  setLinkedSplits,
  setRatio,
  showSession,
  splitPane,
  splitterSpecs,
  swapPanes,
  tabInsertBefore,
  templateOf,
  togglePanePin,
  visibleSessions,
} from "./pane-layout";

const L = (id: number, session: string | null = null): PaneNode => ({kind: "leaf", id, session});
const S = (dir: "row" | "col", a: PaneNode, b: PaneNode, ratio = 0.5): PaneNode => ({kind: "split", dir, ratio, a, b});

function state(root: PaneNode, extra: Partial<PaneState> = {}): PaneState {
  return {root, focused: leaves(root)[0].id, tabOrder: [], linkedSplits: true, ...extra};
}

const sessionsOf = (s: PaneState) => leaves(s.root).map(l => l.session);
const grid = (a: string | null = "a", b: string | null = "b", c: string | null = "c", d: string | null = "d") =>
  S("col", S("row", L(1, a), L(2, b)), S("row", L(3, c), L(4, d)));

describe("splitPane", () => {
  it("splits a leaf in each direction and focuses the new pane", () => {
    const base = state(L(1, "a"));
    const right = splitPane(base, 1, "right", "b")!;
    expect(right.root).toEqual(S("row", L(1, "a"), L(2, "b")));
    expect(right.focused).toBe(2);
    expect(splitPane(base, 1, "left", null)!.root).toEqual(S("row", L(2), L(1, "a")));
    expect(splitPane(base, 1, "top", null)!.root).toEqual(S("col", L(2), L(1, "a")));
    expect(splitPane(base, 1, "bottom", null)!.root).toEqual(S("col", L(1, "a"), L(2)));
  });

  it("splits only the target cell of a nested tree", () => {
    const s = splitPane(state(S("row", L(1, "a"), L(2, "b"))), 2, "bottom", "c")!;
    expect(s.root).toEqual(S("row", L(1, "a"), S("col", L(2, "b"), L(3, "c"))));
  });

  it("moves the session out of its previous pane", () => {
    const s = splitPane(state(S("row", L(1, "a"), L(2, "b"))), 1, "right", "b")!;
    expect(sessionsOf(s)).toEqual(["a", "b", null]);
  });

  it("dropping a pane's own session on its edge is a no-op", () => {
    const s = state(S("row", L(1, "a"), L(2, "b")));
    expect(splitPane(s, 1, "right", "a")).toBe(s);
  });

  it("producing a linked 2×2 aligns the child splits", () => {
    const s = state(S("row", S("col", L(1), L(3), 0.3), L(2)));
    const split2 = splitPane(s, 2, "bottom", null)!;
    expect(is2x2(split2.root)).toBe(true);
    expect(nodeRatios(split2.root)).toEqual([0.5, 0.3, 0.3]);
    expect(crossHandle(split2)).toMatchObject({y: 0.3});
    const free = splitPane({...s, linkedSplits: false}, 2, "bottom", null)!;
    expect(nodeRatios(free.root)).toEqual([0.5, 0.3, 0.5]);
  });

  it("refuses to go beyond the pane limit", () => {
    let s = state(L(1));
    for (let i = 1; i < MAX_PANES; i++) s = splitPane(s, s.focused, "right", null)!;
    expect(leaves(s.root)).toHaveLength(MAX_PANES);
    expect(splitPane(s, 1, "bottom", null)).toBeNull();
  });
});

describe("closePane", () => {
  it("lets the sibling take the space and moves focus into it", () => {
    const s = closePane(state(S("row", L(1, "a"), S("col", L(2, "b"), L(3, "c"))), {focused: 2}), 2);
    expect(s.root).toEqual(S("row", L(1, "a"), L(3, "c")));
    expect(s.focused).toBe(3);
  });

  it("collapsing to a linked 2×2 aligns the child splits", () => {
    const root = S("row", S("col", L(1), L(2), 0.3), S("col", L(3), S("row", L(4), L(5)), 0.6));
    const closed = closePane(state(root), 4);
    expect(is2x2(closed.root)).toBe(true);
    expect(nodeRatios(closed.root)).toEqual([0.5, 0.3, 0.3]);
    // The result still has the 2×2 shape (both children perpendicular splits), so it is linked too
    const moved = movePane(state(root), 4, 5, "right");
    expect(nodeRatios(moved.root)).toEqual([0.5, 0.3, 0.3, 0.5]);
  });

  it("never closes the last pane", () => {
    const s = state(L(1, "a"));
    expect(closePane(s, 1)).toBe(s);
  });

  it("keeps focus when another pane closes", () => {
    const s = closePane(state(S("row", L(1, "a"), L(2, "b")), {focused: 1}), 2);
    expect(s.root).toEqual(L(1, "a"));
    expect(s.focused).toBe(1);
  });
});

describe("movePane", () => {
  it("moves a pane next to another one without changing the count", () => {
    const s = movePane(state(S("row", L(1, "a"), S("col", L(2, "b"), L(3, "c")))), 1, 3, "right");
    expect(leaves(s.root)).toHaveLength(3);
    expect(s.root).toEqual(S("col", L(2, "b"), S("row", L(3, "c"), L(4, "a"))));
  });

  it("ignores moving a pane onto itself", () => {
    const s = state(S("row", L(1, "a"), L(2, "b")));
    expect(movePane(s, 1, 1, "left")).toBe(s);
  });
});

describe("session placement", () => {
  it("assigns a session to one pane only and focuses it", () => {
    const s = assignSession(state(S("row", L(1, "a"), L(2, "b"))), 2, "a");
    expect(sessionsOf(s)).toEqual([null, "a"]);
    expect(s.focused).toBe(2);
  });

  it("tab click focuses the pane showing the session, else uses the focused pane", () => {
    const base = state(S("row", L(1, "a"), L(2, "b")), {focused: 1});
    expect(showSession(base, "b").focused).toBe(2);
    expect(sessionsOf(showSession(base, "c"))).toEqual(["c", "b"]);
  });

  it("fills an empty focused pane first", () => {
    const base = state(S("row", L(1, "a"), L(2, null)), {focused: 2});
    const s = showSession(base, "c");
    expect(sessionsOf(s)).toEqual(["a", "c"]);
    expect(s.focused).toBe(2);
  });

  it("fills the first empty pane instead of replacing the focused one", () => {
    const base = state(grid("a", null, "c", null), {focused: 1});
    const s = showSession(base, "x");
    expect(sessionsOf(s)).toEqual(["a", "x", "c", null]);
    expect(s.focused).toBe(2);
    const t = showSession(s, "y");
    expect(sessionsOf(t)).toEqual(["a", "x", "c", "y"]);
    expect(t.focused).toBe(4);
  });

  it("replaces the focused pane only when no pane is empty", () => {
    const base = state(grid("a", "b", "c", "d"), {focused: 3});
    expect(sessionsOf(showSession(base, "x"))).toEqual(["a", "b", "x", "d"]);
  });

  it("swaps two panes, an empty target just receives the session", () => {
    const s = swapPanes(state(grid("a", "b", null, "d")), 1, 3);
    expect(sessionsOf(s)).toEqual([null, "b", "a", "d"]);
    expect(s.focused).toBe(3);
    const unchanged = state(L(1, "a"));
    expect(swapPanes(unchanged, 1, 9)).toBe(unchanged);
  });

  it("ignores unknown panes", () => {
    const s = state(L(1));
    expect(focusPane(s, 7)).toBe(s);
    expect(assignSession(s, 7, "a")).toBe(s);
  });

  it("a closed session leaves its pane empty; the focused pane gets the next hidden tab", () => {
    const s = state(S("row", L(1, "a"), L(2, "b")), {focused: 1, tabOrder: ["a", "b", "c"]});
    const next = removeSession(s, "a", ["b", "c"]);
    expect(sessionsOf(next)).toEqual(["c", "b"]);
    expect(next.tabOrder).toEqual(["b", "c"]);
    expect(sessionsOf(removeSession(s, "b", ["a"]))).toEqual(["a", null]);
    expect(leaves(removeSession(s, "a", []).root)).toHaveLength(2);
  });

  it("prunes unknown sessions and lists visible ones", () => {
    const s = pruneSessions(state(S("row", L(1, "a"), L(2, "x")), {tabOrder: ["x", "a"]}), new Set(["a"]));
    expect(visibleSessions(s)).toEqual(["a"]);
    expect(s.tabOrder).toEqual(["a"]);
    expect(focusedSession(s)).toBe("a");
  });
});

describe("pinned panes", () => {
  const P = (id: number, session: string | null = null): PaneNode => ({kind: "leaf", id, session, pinned: true});
  const pins = (s: PaneState) => leaves(s.root).map(l => l.pinned === true);

  it("toggles a pin; an empty pane cannot be newly pinned", () => {
    const base = state(S("row", L(1, "a"), L(2)));
    const pinned = togglePanePin(base, 1);
    expect(pins(pinned)).toEqual([true, false]);
    expect(pins(togglePanePin(pinned, 1))).toEqual([false, false]);
    expect(togglePanePin(base, 2)).toBe(base);
    expect(togglePanePin(base, 9)).toBe(base);
  });

  it("a new session replaces the first unpinned pane when the focused one is pinned", () => {
    const base = state(grid("a", "b", "c", "d"), {focused: 1});
    const root = S("col", S("row", P(1, "a"), P(2, "b")), S("row", L(3, "c"), L(4, "d")));
    const s = showSession({...base, root}, "x");
    expect(sessionsOf(s)).toEqual(["a", "b", "x", "d"]);
    expect(s.focused).toBe(3);
  });

  it("an empty pinned pane is skipped; an unpinned focused pane is still replaced", () => {
    const s = showSession(state(S("row", P(1), L(2, "b")), {focused: 2}), "x");
    expect(sessionsOf(s)).toEqual([null, "x"]);
  });

  it("does nothing when every pane is pinned, but still focuses an already shown session", () => {
    const base = state(S("row", P(1, "a"), P(2, "b")), {focused: 1});
    expect(showSession(base, "x")).toBe(base);
    expect(showSession(base, "b").focused).toBe(2);
  });

  it("a pinned pane refuses a different session but accepts one while empty", () => {
    const base = state(S("row", P(1, "a"), P(2)));
    expect(canAssign(base, 1, "x")).toBe(false);
    expect(assignSession(base, 1, "x")).toBe(base);
    expect(sessionsOf(assignSession(base, 2, "x"))).toEqual(["a", "x"]);
  });

  it("a closed session keeps the pin and does not refill the pinned focused pane", () => {
    const base = state(S("row", P(1, "a"), L(2, "b")), {focused: 1, tabOrder: ["a", "b", "c"]});
    const s = removeSession(base, "a", ["b", "c"]);
    expect(sessionsOf(s)).toEqual([null, "b"]);
    expect(pins(s)).toEqual([true, false]);
  });

  it("moving the session elsewhere on purpose lifts the pin", () => {
    const s = assignSession(state(S("row", P(1, "a"), L(2))), 2, "a");
    expect(sessionsOf(s)).toEqual([null, "a"]);
    expect(pins(s)).toEqual([false, false]);
  });

  it("the pin follows the content on swap, move and template changes", () => {
    const base = state(S("row", P(1, "a"), L(2, "b")));
    expect(pins(swapPanes(base, 1, 2))).toEqual([false, true]);
    const moved = movePane(base, 1, 2, "bottom");
    expect(leaves(moved.root).find(l => l.session === "a")?.pinned).toBe(true);
    const rows = applyTemplate(base, "rows");
    expect(pins(rows)).toEqual([true, false]);
  });

  it("persists the pin", () => {
    const s = parsePaneState(JSON.parse(JSON.stringify(state(S("row", P(1, "a"), L(2, "b"))))));
    expect(pins(s)).toEqual([true, false]);
  });
});

describe("templates", () => {
  it("rebuilds the tree keeping shown sessions in order", () => {
    const s = applyTemplate(state(grid("a", null, "c", "d"), {focused: 4}), "columns");
    expect(s.root).toEqual(S("row", L(1, "a"), L(2, "c")));
    expect(s.focused).toBe(1);
    const g = applyTemplate(state(S("row", L(1, "a"), L(2, "b")), {focused: 2}), "grid");
    expect(sessionsOf(g)).toEqual(["a", "b", null, null]);
    expect(g.focused).toBe(2);
  });

  it("single keeps the focused pane's session", () => {
    const s = applyTemplate(state(S("row", L(1, "a"), L(2, "b")), {focused: 2}), "single");
    expect(s.root).toEqual(L(1, "b"));
    expect(s.focused).toBe(1);
    expect(applyTemplate(state(S("row", L(1, "a"), L(2)), {focused: 2}), "single").root).toEqual(L(1));
  });

  it("recognises the current template", () => {
    expect(templateOf(L(1))).toBe("single");
    expect(templateOf(S("row", L(1), L(2)))).toBe("columns");
    expect(templateOf(S("col", L(1), L(2)))).toBe("rows");
    expect(templateOf(grid())).toBe("grid");
    expect(templateOf(S("row", L(1), S("col", L(2), L(3))))).toBeNull();
  });

  it("detects the 2×2 shape in both orientations", () => {
    expect(is2x2(grid())).toBe(true);
    expect(is2x2(S("row", S("col", L(1), L(2)), S("col", L(3), L(4))))).toBe(true);
    expect(is2x2(S("row", S("row", L(1), L(2)), S("col", L(3), L(4))))).toBe(false);
  });
});

describe("ratios", () => {
  it("clamps to 15–85%", () => {
    expect(clampSplit(0)).toBe(0.15);
    expect(clampSplit(1)).toBe(0.85);
    expect(clampSplit(NaN)).toBe(0.5);
  });

  it("linked 2×2 moves both child splits together, free moves one", () => {
    const linked = setRatio(state(grid()), "b", 0.3);
    expect(nodeRatios(linked.root)).toEqual([0.5, 0.3, 0.3]);
    const free = setRatio(state(grid(), {linkedSplits: false}), "b", 0.3);
    expect(nodeRatios(free.root)).toEqual([0.5, 0.5, 0.3]);
  });

  it("only the 2×2 shape links child splits", () => {
    const s = setRatio(state(S("row", S("row", L(1), L(2)), S("col", L(3), L(4)))), "b", 0.3);
    expect(nodeRatios(s.root)).toEqual([0.5, 0.5, 0.3]);
  });

  it("linking aligns the second child split with the first", () => {
    const free = state(S("col", S("row", L(1), L(2), 0.4), S("row", L(3), L(4), 0.7)), {linkedSplits: false});
    const linked = setLinkedSplits(free, true);
    expect(nodeRatios(linked.root)).toEqual([0.5, 0.4, 0.4]);
    expect(linked.linkedSplits).toBe(true);
  });
});

function nodeRatios(node: PaneNode): number[] {
  return node.kind === "leaf" ? [] : [node.ratio, ...nodeRatios(node.a), ...nodeRatios(node.b)];
}

describe("geometry", () => {
  it("lays out nested panes", () => {
    const root = S("row", L(1), S("col", L(2), L(3), 0.25), 0.4);
    expect(paneRects(root)).toEqual([
      {id: 1, rect: {left: 0, top: 0, width: 0.4, height: 1}},
      {id: 2, rect: {left: 0.4, top: 0, width: 0.6, height: 0.25}},
      {id: 3, rect: {left: 0.4, top: 0.25, width: 0.6, height: 0.75}},
    ]);
    expect(splitterSpecs(root)).toEqual([
      {path: "", axis: "x", pos: 0.4, from: 0, to: 1, start: 0, size: 1},
      {path: "b", axis: "y", pos: 0.25, from: 0.4, to: 1, start: 0, size: 1},
    ]);
  });

  it("has no splitter for a single pane", () => {
    expect(splitterSpecs(L(1))).toEqual([]);
    expect(paneRects(L(1))).toEqual([{id: 1, rect: {left: 0, top: 0, width: 1, height: 1}}]);
  });

  it("offers the cross handle only for a linked 2×2", () => {
    const root = S("col", S("row", L(1), L(2), 0.3), S("row", L(3), L(4), 0.3), 0.6);
    expect(crossHandle(state(root))).toEqual({x: 0.3, y: 0.6, xPath: "a", yPath: ""});
    const rowRoot = S("row", S("col", L(1), L(2), 0.2), S("col", L(3), L(4), 0.2), 0.7);
    expect(crossHandle(state(rowRoot))).toEqual({x: 0.7, y: 0.2, xPath: "", yPath: "a"});
    expect(crossHandle(state(root, {linkedSplits: false}))).toBeNull();
    expect(crossHandle(state(S("row", L(1), L(2))))).toBeNull();
  });

  it("maps pointer positions to drop zones", () => {
    expect(dropZone(0.1, 0.5, true)).toBe("left");
    expect(dropZone(0.95, 0.5, true)).toBe("right");
    expect(dropZone(0.5, 0.05, true)).toBe("top");
    expect(dropZone(0.5, 0.9, true)).toBe("bottom");
    expect(dropZone(0.5, 0.5, true)).toBe("center");
    expect(dropZone(0.1, 0.5, false)).toBe("center");
  });
});

describe("tab order", () => {
  it("appends unknown ids only once", () => {
    expect(ensureInTabOrder(["a"], "b")).toEqual(["a", "b"]);
    expect(ensureInTabOrder(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  it("finds the tab to insert before according to the saved order", () => {
    expect(tabInsertBefore(["a", "b", "c"], "b", ["a", "c"])).toBe("c");
    expect(tabInsertBefore(["a", "b", "c"], "c", ["a", "b"])).toBeNull();
    expect(tabInsertBefore(["a"], "z", ["a"])).toBeNull();
  });

  it("moves a tab before or after a target", () => {
    expect(moveTab(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveTab(["a", "b", "c"], "a", "b", true)).toEqual(["b", "a", "c"]);
    expect(moveTab(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(moveTab(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });
});

describe("parsePaneState", () => {
  it("returns defaults for garbage", () => {
    expect(parsePaneState(null)).toEqual(createPaneState());
    expect(parsePaneState("x")).toEqual(createPaneState());
    expect(parsePaneState({root: {kind: "nope"}, tabOrder: ["a"]})).toEqual({...createPaneState(), tabOrder: ["a"]});
  });

  it("round-trips a tree with fresh ids and maps the focused pane", () => {
    const root = S("row", L(7, "a"), S("col", L(3, "b"), L(9), 0.3), 0.6);
    const parsed = parsePaneState(JSON.parse(JSON.stringify({root, focused: 3, tabOrder: ["a", "b"], linkedSplits: false})));
    expect(parsed).toEqual({
      root: S("row", L(1, "a"), S("col", L(2, "b"), L(3), 0.3), 0.6),
      focused: 2,
      tabOrder: ["a", "b"],
      linkedSplits: false,
    });
  });

  it("repairs ratios and duplicate sessions, rejects oversized trees", () => {
    const parsed = parsePaneState({root: S("row", L(1, "a"), L(2, "a"), 3), focused: 99});
    expect(parsed.root).toEqual(S("row", L(1, "a"), L(2), 0.85));
    expect(parsed.focused).toBe(1);
    let big: PaneNode = L(1);
    for (let i = 2; i <= MAX_PANES + 1; i++) big = S("row", big, L(i));
    expect(parsePaneState({root: big}).root).toEqual(L(1));
  });

  it("aligns a stored linked 2×2", () => {
    const parsed = parsePaneState({root: S("col", S("row", L(1), L(2), 0.3), S("row", L(3), L(4), 0.7))});
    expect(nodeRatios(parsed.root)).toEqual([0.5, 0.3, 0.3]);
  });

  it("migrates the previous fixed-layout format", () => {
    const grid2 = parsePaneState({
      layout: "grid", panes: ["a", null, "b", "a"], focused: 2,
      splits: {gridTop: 0.3, gridBottom: 0.7, gridY: 0.6}, linkedSplits: false,
    });
    expect(grid2.root).toEqual(S("col", S("row", L(1, "a"), L(2), 0.3), S("row", L(3, "b"), L(4), 0.7), 0.6));
    expect(grid2.focused).toBe(3);
    const cols = parsePaneState({layout: "columns", panes: ["a", "b"], splits: {columns: 0.3}});
    expect(cols.root).toEqual(S("row", L(1, "a"), L(2, "b"), 0.3));
    const oldShared = parsePaneState({layout: "grid", splits: {gridX: 0.4}});
    expect(nodeRatios(oldShared.root)).toEqual([0.5, 0.4, 0.4]);
    expect(parsePaneState({layout: "single", panes: ["a"]}).root).toEqual(L(1, "a"));
  });
});
