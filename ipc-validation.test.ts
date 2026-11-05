import {assertDirectoryInProjects, assertMcpConfig, isKnownSessionId} from "./ipc-validation";

describe("isKnownSessionId", () => {
  const ids = new Set(["session-1", "session-2"]);

  it("accepts an id in the set", () => {
    expect(isKnownSessionId("session-1", ids)).toBe(true);
  });

  it("rejects an id that is not in the set", () => {
    expect(isKnownSessionId("session-3", ids)).toBe(false);
  });

  it("rejects values that are not strings", () => {
    for (const value of [undefined, null, 1, {}, ["session-1"], true]) {
      expect(isKnownSessionId(value, ids)).toBe(false);
    }
  });

  it("works with a Map's key lookup (anything with has)", () => {
    const map = new Map([["session-1", {}]]);
    expect(isKnownSessionId("session-1", map)).toBe(true);
    expect(isKnownSessionId("session-2", map)).toBe(false);
  });
});

describe("assertDirectoryInProjects", () => {
  const dirs = ["/a/b", "/work/app"];

  it("returns the normalized registered directory", () => {
    expect(assertDirectoryInProjects("/a/b", dirs)).toBe("/a/b");
  });

  it("ignores a trailing slash on either side", () => {
    expect(assertDirectoryInProjects("/a/b/", dirs)).toBe("/a/b");
    expect(assertDirectoryInProjects("/work/app", ["/work/app/"])).toBe("/work/app");
  });

  it("rejects a sibling that only shares the prefix", () => {
    expect(() => assertDirectoryInProjects("/a/b-kotu", dirs)).toThrow(/not in any project/);
  });

  it("rejects a path that escapes with ..", () => {
    expect(() => assertDirectoryInProjects("/a/b/../c", dirs)).toThrow(/not in any project/);
  });

  it("accepts a path that resolves back to a registered directory", () => {
    expect(assertDirectoryInProjects("/a/c/../b", dirs)).toBe("/a/b");
  });

  it("rejects a subdirectory of a project", () => {
    expect(() => assertDirectoryInProjects("/a/b/sub", dirs)).toThrow(/not in any project/);
  });

  it("rejects a directory when no project has one", () => {
    expect(() => assertDirectoryInProjects("/a/b", [])).toThrow(/not in any project/);
  });

  it("rejects values that are not non-empty absolute path strings", () => {
    for (const value of [undefined, null, 5, {}, "", "relative/dir"]) {
      expect(() => assertDirectoryInProjects(value, dirs)).toThrow(/absolute path/);
    }
  });
});

describe("assertMcpConfig", () => {
  it("returns a plain object unchanged", () => {
    const config = {command: "npx", args: ["x"], env: {A: "1"}};
    expect(assertMcpConfig(config)).toBe(config);
  });

  it("accepts an empty object and does not inspect its shape", () => {
    expect(assertMcpConfig({})).toEqual({});
    expect(assertMcpConfig({type: "http", url: 5})).toEqual({type: "http", url: 5});
  });

  it("rejects null, arrays, strings, numbers and undefined", () => {
    for (const value of [null, [], ["a"], "{}", 1, true, undefined]) {
      expect(() => assertMcpConfig(value)).toThrow(/MCP server config/);
    }
  });

  it("rejects class instances and other non-plain objects", () => {
    expect(() => assertMcpConfig(new Date())).toThrow(/MCP server config/);
    expect(() => assertMcpConfig(new Map())).toThrow(/MCP server config/);
  });
});
