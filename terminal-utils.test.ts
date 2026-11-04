import {isCopyKey, resyncViewport} from "./terminal-utils";

const key = (code: string, mods: {ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean} = {}, type = "keydown") => ({
  type,
  code,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});

describe("isCopyKey", () => {
  it("Ctrl+C copies only while text is selected, otherwise it stays an interrupt", () => {
    expect(isCopyKey(key("KeyC", {ctrl: true}), true)).toBe(true);
    expect(isCopyKey(key("KeyC", {ctrl: true}), false)).toBe(false);
  });

  it("Ctrl+Shift+C copies whenever there is a selection", () => {
    expect(isCopyKey(key("KeyC", {ctrl: true, shift: true}), true)).toBe(true);
    expect(isCopyKey(key("KeyC", {ctrl: true, shift: true}), false)).toBe(false);
  });

  it("Cmd+C copies on macOS", () => {
    expect(isCopyKey(key("KeyC", {meta: true}), true)).toBe(true);
  });

  it("ignores other keys, Alt combinations and key releases", () => {
    expect(isCopyKey(key("KeyV", {ctrl: true}), true)).toBe(false);
    expect(isCopyKey(key("KeyC"), true)).toBe(false);
    expect(isCopyKey(key("KeyC", {ctrl: true, alt: true}), true)).toBe(false);
    expect(isCopyKey(key("KeyC", {ctrl: true}, "keyup"), true)).toBe(false);
  });
});

describe("resyncViewport", () => {
  const fake = (viewportY: number) => {
    const calls: number[] = [];
    return {calls, term: {buffer: {active: {viewportY}}, scrollLines: (n: number) => { calls.push(n); }}};
  };

  it("scrolls away and back, so xterm writes the DOM scroll position again at the same line", () => {
    const {calls, term} = fake(385);
    resyncViewport(term);
    expect(calls).toEqual([-1, 1]);
  });

  it("does nothing at the top: the browser's reset position is already right there", () => {
    const {calls, term} = fake(0);
    resyncViewport(term);
    expect(calls).toEqual([]);
  });
});
