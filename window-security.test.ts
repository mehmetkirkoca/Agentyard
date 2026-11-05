import * as fs from "fs";
import * as path from "path";
import {createTrustedIpc, hardenNavigation, isTrustedSender} from "./window-security";

describe("hardenNavigation", () => {
  function fakeContents() {
    const handlers = new Map<string, (event: {preventDefault(): void}) => void>();
    let openHandler: (() => {action: string}) | undefined;
    return {
      on: (name: string, fn: (event: {preventDefault(): void}) => void) => { handlers.set(name, fn); },
      setWindowOpenHandler: (fn: () => {action: "deny"}) => { openHandler = fn; },
      navigate() {
        const preventDefault = jest.fn();
        handlers.get("will-navigate")?.({preventDefault});
        return preventDefault;
      },
      open: () => openHandler?.(),
    };
  }

  it("cancels every navigation away from the loaded page", () => {
    const contents = fakeContents();
    hardenNavigation(contents);
    expect(contents.navigate()).toHaveBeenCalled();
  });

  it("denies every new window", () => {
    const contents = fakeContents();
    hardenNavigation(contents);
    expect(contents.open()).toEqual({action: "deny"});
  });
});

const INDEX_URL = "file:///opt/Agentyard/resources/app.asar/index.html";

describe("isTrustedSender", () => {
  it("trusts the exact index.html URL", () => {
    expect(isTrustedSender(INDEX_URL, INDEX_URL)).toBe(true);
  });

  it("trusts an encoded URL when it matches exactly", () => {
    const url = "file:///home/u/%C3%87al%C4%B1%C5%9Fma%20Dizini/resources/app.asar/index.html";
    expect(isTrustedSender(url, url)).toBe(true);
  });

  it("rejects a remote page", () => {
    expect(isTrustedSender("https://example.com", INDEX_URL)).toBe(false);
  });

  it("rejects another file:// path", () => {
    expect(isTrustedSender("file:///tmp/evil.html", INDEX_URL)).toBe(false);
    expect(isTrustedSender("file:///opt/Agentyard/resources/app.asar/index.html.evil", INDEX_URL)).toBe(false);
    expect(isTrustedSender("file:///opt/Agentyard/resources/app.asar/index.html/evil", INDEX_URL)).toBe(false);
  });

  it("rejects a missing or empty URL", () => {
    expect(isTrustedSender(undefined, INDEX_URL)).toBe(false);
    expect(isTrustedSender("", INDEX_URL)).toBe(false);
  });

  it("rejects a query string, which loads another document", () => {
    expect(isTrustedSender(`${INDEX_URL}?x=1`, INDEX_URL)).toBe(false);
  });

  it("trusts a fragment on the same document (a click on an href=\"#\" link adds one)", () => {
    expect(isTrustedSender(`${INDEX_URL}#`, INDEX_URL)).toBe(true);
    expect(isTrustedSender(`${INDEX_URL}#section`, INDEX_URL)).toBe(true);
  });
});

describe("createTrustedIpc", () => {
  type Listener = (event: any, ...args: any[]) => any;

  function fakeIpcMain() {
    const handlers = new Map<string, Listener>();
    const listeners = new Map<string, Listener>();
    return {
      handle: (channel: string, listener: Listener) => { handlers.set(channel, listener); },
      on: (channel: string, listener: Listener) => { listeners.set(channel, listener); },
      invoke: (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event, ...args),
      emit: (channel: string, event: unknown, ...args: unknown[]) => listeners.get(channel)!(event, ...args),
    };
  }

  const trusted = {senderFrame: {url: INDEX_URL}};
  const untrusted = {senderFrame: {url: "https://example.com/"}};

  function setup() {
    const ipcMain = fakeIpcMain();
    const log = jest.fn();
    return {ipcMain, log, ipc: createTrustedIpc(ipcMain, INDEX_URL, log)};
  }

  it("runs a handle listener for the trusted sender, with its event, arguments and result", async () => {
    const {ipcMain, ipc, log} = setup();
    const listener = jest.fn(async (_event: unknown, a: number, b: number) => a + b);
    ipc.handle("add", listener);
    await expect(ipcMain.invoke("add", trusted, 1, 2)).resolves.toBe(3);
    expect(listener).toHaveBeenCalledWith(trusted, 1, 2);
    expect(log).not.toHaveBeenCalled();
  });

  it("runs an on listener for the trusted sender, with its event and arguments", () => {
    const {ipcMain, ipc, log} = setup();
    const listener = jest.fn();
    ipc.on("ping", listener);
    ipcMain.emit("ping", trusted, "a", "b");
    expect(listener).toHaveBeenCalledWith(trusted, "a", "b");
    expect(log).not.toHaveBeenCalled();
  });

  it("throws from a rejected handle without running the listener, and logs the URL and channel", () => {
    const {ipcMain, ipc, log} = setup();
    const listener = jest.fn();
    ipc.handle("secret", listener);
    expect(() => ipcMain.invoke("secret", untrusted)).toThrow(/secret/);
    expect(listener).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("secret");
    expect(log.mock.calls[0][0]).toContain("https://example.com/");
  });

  it("ignores a rejected on message without throwing, and logs the URL and channel", () => {
    const {ipcMain, ipc, log} = setup();
    const listener = jest.fn();
    ipc.on("session-input", listener);
    expect(() => ipcMain.emit("session-input", untrusted, "s1", "rm -rf /\r")).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("session-input");
    expect(log.mock.calls[0][0]).toContain("https://example.com/");
  });

  it("treats a null, missing or destroyed sender frame as untrusted", () => {
    const destroyed = {senderFrame: {get url(): string { throw new Error("Render frame was disposed"); }}};
    for (const event of [{senderFrame: null}, {}, destroyed]) {
      const {ipcMain, ipc, log} = setup();
      const onListener = jest.fn();
      const handleListener = jest.fn();
      ipc.on("ping", onListener);
      ipc.handle("pong", handleListener);
      expect(() => ipcMain.emit("ping", event)).not.toThrow();
      expect(() => ipcMain.invoke("pong", event)).toThrow(/pong/);
      expect(onListener).not.toHaveBeenCalled();
      expect(handleListener).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(2);
    }
  });
});

describe("main.ts window and IPC setup", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");

  it("registers IPC only through the trusted wrapper", () => {
    // The import and the one createTrustedIpc(ipcMain, ...) call: any other mention is a bypass
    // (ipcMain.handle, ipcMain.on, handleOnce, addListener, an alias).
    const mentions = main.split("\n").filter(line => /\bipcMain\b/.test(line));
    expect(mentions).toHaveLength(2);
    expect(mentions[0]).toMatch(/^import \{.*\bipcMain\b.*\} from "electron";$/);
    expect(mentions[1]).toMatch(/createTrustedIpc\(ipcMain, /);
  });

  it("turns on isolation for the window", () => {
    expect(main).toMatch(/\bnodeIntegration: false,/);
    expect(main).toMatch(/\bcontextIsolation: true,/);
    expect(main).toMatch(/\bsandbox: true,/);
    expect(main).not.toMatch(/\bnodeIntegration: true/);
    expect(main).not.toMatch(/\bcontextIsolation: false/);
    expect(main).not.toMatch(/\bsandbox: false/);
  });

  it("creates one window only, so no other webPreferences exist", () => {
    expect(main.match(/new BrowserWindow\(/g)).toHaveLength(1);
  });

  it("loads exactly the URL it trusts", () => {
    expect(main).toMatch(/\.loadURL\(INDEX_HTML_URL\)/);
    expect(main).not.toMatch(/\.loadFile\(/);
  });
});

describe("index.html Content-Security-Policy", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const directive = (name: string) => csp.split(";").map(d => d.trim()).find(d => d.startsWith(`${name} `)) ?? "";

  it("defaults to nothing", () => {
    expect(directive("default-src")).toBe("default-src 'none'");
  });

  it("allows only scripts from the page's own origin", () => {
    expect(directive("script-src")).toBe("script-src 'self'");
  });

  it("keeps no inline script in the page", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});
