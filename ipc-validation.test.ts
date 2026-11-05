import {assertMcpConfig, checkInputArgs, isKnownSessionId} from "./ipc-validation";

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

describe("checkInputArgs", () => {
  const ids = new Set(["session-1"]);

  it("is ok for a known session and string data", () => {
    expect(checkInputArgs("session-1", "ls\r", ids)).toBe("ok");
    expect(checkInputArgs("session-1", "", ids)).toBe("ok");
  });

  it("is unknown for an id that is not in the set, even with bad data", () => {
    expect(checkInputArgs("gone", "x", ids)).toBe("unknown-session");
    expect(checkInputArgs("gone", 5, ids)).toBe("unknown-session");
    expect(checkInputArgs(undefined, "x", ids)).toBe("unknown-session");
  });

  it("is bad-data for a known session with non-string data", () => {
    for (const value of [undefined, null, 1, {}, ["x"]]) {
      expect(checkInputArgs("session-1", value, ids)).toBe("bad-data");
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
