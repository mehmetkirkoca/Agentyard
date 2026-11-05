import * as fs from "fs";
import * as path from "path";
import {
  createAgentyardApi,
  EVENT_CHANNELS,
  exposeAgentyardApi,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
} from "./ipc-channels";

type Listener = (event: unknown, ...args: unknown[]) => void;

function fakeIpc() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    invoke: jest.fn(async (_channel: string, ..._args: unknown[]) => "result" as unknown),
    send: jest.fn((_channel: string, ..._args: unknown[]) => {}),
    on: jest.fn((channel: string, listener: Listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(listener);
    }),
    removeListener: jest.fn((channel: string, listener: Listener) => { listeners.get(channel)?.delete(listener); }),
    emit(channel: string, ...args: unknown[]) {
      for (const l of [...(listeners.get(channel) ?? [])]) l({sender: "leaked-event"}, ...args);
    },
    count: (channel: string) => listeners.get(channel)?.size ?? 0,
  };
}

const fakeWebUtils = {getPathForFile: jest.fn((file: unknown) => `/path/of/${(file as {name: string}).name}`)};

describe("createAgentyardApi", () => {
  it("rejects channels outside the allowlist for invoke, send and on", async () => {
    const ipc = fakeIpc();
    const api = createAgentyardApi(ipc, fakeWebUtils);
    await expect(api.invoke("not-a-channel")).rejects.toThrow(/not-a-channel/);
    expect(() => api.send("not-a-channel")).toThrow(/not-a-channel/);
    expect(() => api.on("not-a-channel", () => {})).toThrow(/not-a-channel/);
    expect(ipc.invoke).not.toHaveBeenCalled();
    expect(ipc.send).not.toHaveBeenCalled();
    expect(ipc.on).not.toHaveBeenCalled();
  });

  it("does not let an invoke channel pass as a send or event channel", () => {
    const api = createAgentyardApi(fakeIpc(), fakeWebUtils);
    expect(() => api.send("get-branches")).toThrow();
    expect(() => api.on("session-input", () => {})).toThrow();
  });

  it("forwards allowed invoke and send calls with their arguments", async () => {
    const ipc = fakeIpc();
    const api = createAgentyardApi(ipc, fakeWebUtils);
    await expect(api.invoke("get-branches", "/repo")).resolves.toBe("result");
    expect(ipc.invoke).toHaveBeenCalledWith("get-branches", "/repo");
    api.send("session-input", "s1", "ls\r");
    expect(ipc.send).toHaveBeenCalledWith("session-input", "s1", "ls\r");
  });

  it("passes only the arguments to an event listener, never the event", () => {
    const ipc = fakeIpc();
    const api = createAgentyardApi(ipc, fakeWebUtils);
    const listener = jest.fn();
    api.on("session-output", listener);
    ipc.emit("session-output", "s1", "data");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("s1", "data");
  });

  it("returns a function that removes the listener", () => {
    const ipc = fakeIpc();
    const api = createAgentyardApi(ipc, fakeWebUtils);
    const listener = jest.fn();
    const off = api.on("session-output", listener);
    expect(ipc.count("session-output")).toBe(1);
    off();
    expect(ipc.count("session-output")).toBe(0);
    ipc.emit("session-output", "s1", "data");
    expect(listener).not.toHaveBeenCalled();
  });

  it("delegates getPathForFile to webUtils", () => {
    const api = createAgentyardApi(fakeIpc(), fakeWebUtils);
    expect(api.getPathForFile({name: "a b.txt"} as File)).toBe("/path/of/a b.txt");
  });
});

describe("exposeAgentyardApi", () => {
  it("exposes the api as agentyard on the bridge", () => {
    const bridge = {exposeInMainWorld: jest.fn()};
    exposeAgentyardApi(bridge, fakeIpc(), fakeWebUtils);
    expect(bridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = bridge.exposeInMainWorld.mock.calls[0];
    expect(key).toBe("agentyard");
    expect(Object.keys(api).sort()).toEqual(["getPathForFile", "invoke", "on", "send"]);
  });
});

describe("channel lists against the sources", () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, file), "utf8");
  const scan = (source: string, pattern: RegExp) => new Set([...source.matchAll(pattern)].map(m => m[1]));
  const main = read("main.ts");
  const renderer = read("renderer.ts");
  const client = "(?:ipcRenderer|agentyard)";

  const sorted = (set: Set<string>) => [...set].sort();

  it("INVOKE_CHANNELS is every trustedIpc.handle and renderer invoke channel", () => {
    const used = new Set([
      ...scan(main, /trustedIpc\.handle\(\s*"([^"]+)"/g),
      ...scan(renderer, new RegExp(`${client}\\.invoke\\(\\s*"([^"]+)"`, "g")),
    ]);
    expect(used.size).toBeGreaterThan(25);
    expect(sorted(new Set(INVOKE_CHANNELS))).toEqual(sorted(used));
  });

  it("SEND_CHANNELS is every trustedIpc.on and renderer send channel", () => {
    const used = new Set([
      ...scan(main, /trustedIpc\.on\(\s*"([^"]+)"/g),
      ...scan(renderer, new RegExp(`${client}\\.send\\(\\s*"([^"]+)"`, "g")),
    ]);
    expect(used.size).toBeGreaterThan(12);
    expect(sorted(new Set(SEND_CHANNELS))).toEqual(sorted(used));
  });

  it("EVENT_CHANNELS is every main-to-renderer send, reply and renderer on channel", () => {
    const used = new Set([
      ...scan(main, /webContents\.send\(\s*"([^"]+)"/g),
      ...scan(main, /event\.reply\(\s*"([^"]+)"/g),
      ...scan(renderer, new RegExp(`${client}\\.on\\(\\s*"([^"]+)"`, "g")),
    ]);
    expect(used.size).toBeGreaterThan(15);
    expect(sorted(new Set(EVENT_CHANNELS))).toEqual(sorted(used));
  });

  it("lists contain no duplicates", () => {
    for (const list of [INVOKE_CHANNELS, SEND_CHANNELS, EVENT_CHANNELS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("includes the channels that replace direct Node and Electron use", () => {
    expect(INVOKE_CHANNELS).toEqual(expect.arrayContaining(["clipboard-read-text", "clipboard-write-text", "get-home-dir"]));
  });
});
