"use strict";
// Isolation smoke test: runs the built app in a throwaway HOME and drives it over the Chrome
// DevTools Protocol, so the page is exercised the way a user would, without test hooks in the app.
//
//   node dev/smoke-isolation.js             the app in this checkout (needs `npm run build`)
//   node dev/smoke-isolation.js --packaged  dist/linux-unpacked (needs `npm run pack`), copied to a
//                                           path with spaces and Turkish characters
//
// This file also runs inside Electron: with -r before the app (guard and rejected-sender checks)
// and as the app itself (--seed-storage writes localStorage the way the old window settings did).
// --no-sandbox is passed because chrome-sandbox is not SUID in a fresh install, so the OS layer of
// sandbox: true is NOT exercised here; the JS layer (no Node in the page or the preload) is.

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {pathToFileURL} = require("url");

const REPO = path.resolve(__dirname, "..");
const TIMEOUT_MS = 180000;
const SEEDED_ID = "session-seeded";
const SEEDED_UUID = "11111111-2222-4333-8444-555555555555";
const SEEDED_NAME = "Kayıtlı Oturum";
const SEEDED_STORAGE = {sidebarWidth: "333", projectOrder: JSON.stringify(["proj-seeded"])};
const STUB_MARK = "SMOKE_STUB_READY";
// The stub's own echo is rendered by xterm, which drops nothing: the input log holds the raw bytes
const STUB_LOG = "stub-input.log";

function refuseRealHome() {
  const home = process.env.HOME;
  const real = os.userInfo().homedir;
  if (!home || path.resolve(home) === path.resolve(real) || process.env.SMOKE_ISOLATION !== "1") {
    console.error(`smoke-isolation: refusing to run with HOME=${home} (real home: ${real})`);
    process.exit(3);
  }
}

// ---- Inside Electron -------------------------------------------------------------------------

function seedStorageInElectron() {
  const {app, BrowserWindow, session} = require("electron");
  app.setPath("userData", process.env.SMOKE_USER_DATA);
  app.whenReady().then(async () => {
    // The settings the window had before this change: localStorage must survive the switch
    const win = new BrowserWindow({show: false, webPreferences: {nodeIntegration: true, contextIsolation: false}});
    await win.loadURL(pathToFileURL(process.env.SMOKE_SEED_PAGE).href);
    const entries = JSON.parse(process.env.SMOKE_SEED_ENTRIES);
    await win.webContents.executeJavaScript(
      `for (const [k, v] of Object.entries(${JSON.stringify(entries)})) localStorage.setItem(k, v);`,
    );
    await session.defaultSession.flushStorageData();
    win.destroy();
    app.quit();
  }).catch((error) => {
    console.error("smoke-isolation: seeding failed:", error);
    process.exit(4);
  });
}

function rogueChecksInElectron() {
  const {app, BrowserWindow} = require("electron");
  const rejected = [];
  const realWarn = console.warn;
  console.warn = (...args) => {
    if (String(args[0]).includes("Rejected IPC")) rejected.push(String(args[0]));
    realWarn(...args);
  };

  const windowPrefs = (preload) => ({preload, nodeIntegration: false, contextIsolation: true, sandbox: true});
  const report = (key, value) => console.log(`SMOKE_ELECTRON ${JSON.stringify({key, value})}`);

  app.whenReady().then(async () => {
    while (BrowserWindow.getAllWindows().length === 0) await new Promise(r => setTimeout(r, 50));
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const prefs = mainWindow.webContents.getLastWebPreferences();
    report("mainPrefs", {nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox});

    const rogue = new BrowserWindow({show: false, webPreferences: windowPrefs(path.join(app.getAppPath(), "dist", "preload.js"))});
    await rogue.loadURL(pathToFileURL(process.env.SMOKE_ROGUE_PAGE).href);
    const invoke = await rogue.webContents.executeJavaScript(
      `window.agentyard.invoke("get-home-dir").then(v => ({resolved: v}), e => ({rejected: String(e.message)}))`,
    );
    await rogue.webContents.executeJavaScript(`window.agentyard.send("session-input", "nobody", "echo pwned\\r"); 1`);
    await new Promise(r => setTimeout(r, 300));
    rogue.destroy();
    report("rogue", {invoke, rejected});

    // A preload under sandbox: true loads electron and nothing else, even with --no-sandbox
    const probe = new BrowserWindow({show: false, webPreferences: windowPrefs(process.env.SMOKE_PROBE_PRELOAD)});
    await probe.loadURL(pathToFileURL(process.env.SMOKE_ROGUE_PAGE).href);
    report("preloadProbe", await probe.webContents.executeJavaScript("window.probe"));
    probe.destroy();
  }).catch((error) => {
    console.error("smoke-isolation: rogue checks failed:", error);
    report("rogueError", String(error));
  });
}

// ---- Parent: throwaway HOME ------------------------------------------------------------------

function userDataNames() {
  // package.json name when run from the checkout, productName when packaged
  return ["agentyard", "Agentyard"];
}

function seedHome(home) {
  const seededDir = path.join(home, "seeded project");
  fs.mkdirSync(seededDir, {recursive: true});

  const bin = path.join(home, "smoke-bin");
  fs.mkdirSync(bin);
  const stub = path.join(bin, "claude");
  // No Claude account exists here. The stub keeps the terminal raw so paste bytes reach the log unchanged.
  fs.writeFileSync(stub, `#!/bin/bash
if [ "$1" = mcp ]; then echo "No MCP servers configured."; exit 0; fi
[[ "$*" =~ [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} ]]
printf '\\r\\n${STUB_MARK} %s\\r\\n' "\${BASH_REMATCH[0]}"
printf '\\033[?2004h'
stty raw -echo
exec tee -a "$HOME/${STUB_LOG}"
`, {mode: 0o755});
  // /etc/profile resets PATH, so the stub goes in after it: `bash -l` must never find a real claude
  fs.writeFileSync(path.join(home, ".bash_profile"), `export PATH="${bin}:$PATH"\nPS1='$ '\n`);

  const config = {
    projects: [{id: "proj-seeded", name: "Kayıtlı Proje", dirs: [seededDir]}],
    sessions: [{
      id: SEEDED_ID,
      number: 7,
      name: SEEDED_NAME,
      config: {projectDir: seededDir, sessionType: "local", codingAgent: "claude", skipPermissions: false},
      createdAt: 1700000000000,
      sessionUuid: SEEDED_UUID,
      projectId: "proj-seeded",
      origin: "agentyard",
      manualName: true,
      linkedDir: seededDir,
    }],
  };
  for (const name of userDataNames()) {
    const dir = path.join(home, ".config", name);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  }
}

function seededStorageEntries() {
  const panes = {root: {kind: "leaf", id: 1, session: SEEDED_ID}, focused: 1, tabOrder: [SEEDED_ID], linkedSplits: true};
  return {
    ...SEEDED_STORAGE,
    workspaces: JSON.stringify({
      workspaces: [{id: "default", name: "Default", panes}],
      activeId: "default",
      membership: {[SEEDED_ID]: "default"},
      sidebarFilter: false,
    }),
  };
}

function childEnv(home, extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC|ELECTRON_RUN_AS_NODE|DBUS_SESSION_BUS_ADDRESS)/.test(key)) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    SMOKE_ISOLATION: "1",
    ...extra,
  };
}

function hasXvfbRun() {
  return process.platform === "linux" && childProcess.spawnSync("which", ["xvfb-run"], {stdio: "ignore"}).status === 0;
}

function displayCommand(binary, args) {
  // In a Wayland session Electron picks Wayland and ignores xvfb-run's DISPLAY: the window lands on the
  // real desktop, whose compositor sends no frames while the screen is locked, and xterm draws in rAF
  if (hasXvfbRun()) return ["xvfb-run", ["-a", "-s", "-screen 0 1400x900x24", binary, "--ozone-platform=x11", ...args]];
  if (process.platform === "linux") console.warn("smoke-isolation: xvfb-run not found, using the current display");
  return [binary, args];
}

let liveChild = null;

function launch(binary, args, env) {
  const [file, argv] = displayCommand(binary, args);
  // A process group of its own: xvfb-run, Electron and every PTY shell stop together
  liveChild = childProcess.spawn(file, argv, {env, cwd: env.HOME, detached: true, stdio: ["ignore", "pipe", "pipe"]});
  return liveChild;
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone
  }
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

// ---- Parent: DevTools Protocol ---------------------------------------------------------------

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener("message", (message) => {
      const data = JSON.parse(message.data);
      if (data.id && this.pending.has(data.id)) {
        const {resolve, reject} = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(`${data.error.message} (${data.error.code})`));
        else resolve(data.result);
      } else if (data.method) {
        for (const listener of this.listeners) listener(data.method, data.params);
      }
    });
  }

  static open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Cdp(socket)));
      socket.addEventListener("error", () => reject(new Error(`DevTools connection failed: ${url}`)));
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true, userGesture: true});
    if (result.exceptionDetails) {
      throw new Error(`${expression.slice(0, 80)}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, description, ms = 20000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

// ---- Parent: one app run ---------------------------------------------------------------------

class Results {
  constructor() { this.failed = 0; this.notTested = []; }
  check(name, ok, detail) {
    if (!ok) this.failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
  skip(name, why) {
    this.notTested.push(name);
    console.log(`NOT TESTED ${name}: ${why}`);
  }
}

async function startApp({binary, args, env}) {
  const child = launch(binary, args, env);
  const app = {child, output: "", electron: {}};
  const onData = (chunk) => {
    const text = chunk.toString();
    app.output += text;
    for (const line of text.split("\n")) {
      const report = /SMOKE_ELECTRON (.*)$/.exec(line);
      if (report) {
        const {key, value} = JSON.parse(report[1]);
        app.electron[key] = value;
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const browserUrl = await waitFor(() => /DevTools listening on (ws:\/\/\S+)/.exec(app.output)?.[1], "the DevTools endpoint", 30000);
  const {host} = new URL(browserUrl);
  const page = await waitFor(async () => {
    const targets = await (await fetch(`http://${host}/json/list`)).json();
    return targets.find(t => t.type === "page" && /\/index\.html(#.*)?$/.test(t.url));
  }, "the index.html page", 30000);
  app.cdp = await Cdp.open(page.webSocketDebuggerUrl);
  app.consoleErrors = [];
  app.cdp.listeners.push((method, params) => {
    if (method === "Runtime.exceptionThrown") app.consoleErrors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    if (method === "Log.entryAdded" && params.entry.level === "error") app.consoleErrors.push(`${params.entry.text} ${params.entry.url ?? ""}`);
  });
  await app.cdp.send("Runtime.enable");
  await app.cdp.send("Log.enable");
  await app.cdp.send("Page.enable");
  return app;
}

async function stopApp(app) {
  try {
    await app.cdp.evaluate(`window.agentyard.send("window-control", "close"); 1`);
  } catch {
    // The page may be gone; the signals below still stop the app
  }
  app.cdp.close();
  // Waiting for the graceful exit is what flushes localStorage for the next run
  if (!(await waitExit(app.child, 8000))) killGroup(app.child, "SIGTERM");
  if (!(await waitExit(app.child, 4000))) killGroup(app.child, "SIGKILL");
  await waitExit(app.child, 2000);
  // xvfb-run can exit before the shells it left behind
  killGroup(app.child, "SIGKILL");
}

const textOfTerminals = `[...document.querySelectorAll(".xterm-rows")].map(r => r.textContent).join("\\n")`;

async function boundsOfTerminal(cdp, marker) {
  return cdp.evaluate(`(() => {
    for (const el of document.querySelectorAll(".xterm")) {
      if (!el.textContent.includes(${JSON.stringify(marker)})) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    }
    return null;
  })()`);
}

async function checkIsolation(cdp, results, home) {
  const globals = await cdp.evaluate(`({
    require: typeof require, process: typeof process, module: typeof module,
    Buffer: typeof Buffer, global: typeof global, api: Object.keys(window.agentyard).sort(),
  })`);
  results.check("page has no require", globals.require === "undefined", globals.require);
  results.check("page has no process", globals.process === "undefined", globals.process);
  results.check("page has no module, Buffer or global", [globals.module, globals.Buffer, globals.global].every(t => t === "undefined"));
  results.check("preload API is exposed", globals.api.join() === "getPathForFile,invoke,on,send", globals.api);
  results.check("IPC reaches main from the trusted page, in the isolated HOME", await cdp.evaluate(`window.agentyard.invoke("get-home-dir")`) === home);

  const injected = await cdp.evaluate(`(async () => {
    const div = document.createElement("div");
    div.innerHTML = '<img src="x://bad" onerror="window.__pwnAttr = 1">';
    document.body.appendChild(div);
    const script = document.createElement("script");
    script.textContent = "window.__pwnScript = 1";
    document.body.appendChild(script);
    await new Promise(r => setTimeout(r, 400));
    div.remove();
    script.remove();
    let evalBlocked = false;
    try { (0, eval)("1"); } catch { evalBlocked = true; }
    return {attr: typeof window.__pwnAttr, script: typeof window.__pwnScript, evalBlocked};
  })()`);
  results.check("injected onerror does not run", injected.attr === "undefined");
  results.check("injected inline script does not run", injected.script === "undefined");
  results.check("eval is blocked", injected.evalBlocked);

  const before = await cdp.evaluate("location.href");
  results.check("app data folder is private", (fs.statSync(path.join(home, ".agentyard")).mode & 0o777) === 0o700);
  results.check("window.open is denied", await cdp.evaluate(`window.open("https://example.com/") === null`));
  for (const target of ["https://example.com/", "file:///etc/hostname"]) {
    await cdp.evaluate(`location.href = ${JSON.stringify(target)}; 1`);
    await sleep(600);
    results.check(`navigation to ${target} is blocked`, await cdp.evaluate("location.href") === before);
  }
  await cdp.evaluate(`location.hash = "smoke"; 1`);
  results.check("IPC still works with a fragment on the URL", await cdp.evaluate(`window.agentyard.invoke("get-home-dir")`) === home);
  await cdp.evaluate(`history.replaceState(null, "", location.pathname); 1`);

  const sheets = await cdp.evaluate(`[...document.styleSheets].map(s => {
    let rules = -1;
    try { rules = s.cssRules.length; } catch {}
    return {href: s.href, rules};
  }).filter(s => s.href)`);
  for (const name of ["node_modules/xterm/css/xterm.css", "dist/styles.css"]) {
    const sheet = sheets.find(s => s.href.endsWith(name));
    results.check(`${name} loads`, !!sheet && sheet.rules > 0, sheet);
  }
}

async function checkSeededData(cdp, results, entries) {
  await waitFor(() => cdp.evaluate(`document.body.textContent.includes(${JSON.stringify(SEEDED_NAME)})`), "the seeded session in the sidebar");
  results.check("saved session is listed", true, SEEDED_NAME);
  results.check("saved project is listed", await cdp.evaluate(`document.body.textContent.includes("Kayıtlı Proje")`));

  const stored = await cdp.evaluate(`Object.fromEntries(Object.keys(${JSON.stringify(SEEDED_STORAGE)}).map(k => [k, localStorage.getItem(k)]))`);
  results.check("localStorage keys read back unchanged", JSON.stringify(stored) === JSON.stringify(SEEDED_STORAGE), stored);
  const workspaces = JSON.parse(await cdp.evaluate(`localStorage.getItem("workspaces")`));
  results.check("saved layout reads back", workspaces.workspaces[0].panes.root.session === JSON.parse(entries.workspaces).workspaces[0].panes.root.session, workspaces.workspaces[0].panes.root);
  results.check("sidebar width was restored", await cdp.evaluate(`Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)`) === 333);

  // The saved pane reopens its session at startup: a real PTY behind a saved layout
  await waitFor(() => cdp.evaluate(`${textOfTerminals}.includes(${JSON.stringify(SEEDED_UUID.slice(0, 18))})`), "the saved pane's terminal output", 30000);
  results.check("saved pane reopens its session and draws its PTY output", true);
}

async function checkNewSession(cdp, results, home) {
  await cdp.evaluate(`document.getElementById("new-standalone-session").click(); 1`);
  await waitFor(() => cdp.evaluate(`!document.getElementById("session-directory").disabled && document.getElementById("session-directory").options.length > 0`), "the new session dialog");
  await cdp.evaluate(`document.getElementById("coding-agent").value = "claude";
    document.getElementById("coding-agent").dispatchEvent(new Event("change", {bubbles: true})); 1`);
  await sleep(300);
  await cdp.evaluate(`document.getElementById("create-session").click(); 1`);

  const created = await waitFor(async () => {
    const all = await cdp.evaluate(`window.agentyard.invoke("get-all-sessions")`);
    return all.find(s => s.id !== SEEDED_ID);
  }, "the session created through the dialog");
  const marker = created.sessionUuid.slice(0, 18);
  await waitFor(() => cdp.evaluate(`${textOfTerminals}.includes(${JSON.stringify(marker)})`), "the new session's PTY output in xterm", 30000);
  results.check("session opens through the dialog and its PTY output reaches xterm", true, created.name);
  results.check("xterm draws rows", await cdp.evaluate(`document.querySelectorAll(".xterm-rows > div").length`) > 0);

  const pos = await waitFor(() => boundsOfTerminal(cdp, marker), "the new session's visible terminal");
  const log = () => { try { return fs.readFileSync(path.join(home, STUB_LOG), "utf8"); } catch { return ""; } };

  // Keyboard path: focus, type, session-input, the stub's echo, session-output, xterm
  await cdp.send("Input.dispatchMouseEvent", {type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1});
  await cdp.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1});
  await cdp.send("Input.insertText", {text: "smoke-typed-input"});
  await waitFor(() => log().includes("smoke-typed-input"), "typed input in the PTY");
  await waitFor(() => cdp.evaluate(`${textOfTerminals}.includes("smoke-typed-input")`), "the echo of typed input in xterm");
  results.check("typed input goes through session-input and its echo through session-output", true);

  // Right-click paste through the real contextmenu handler: order and line breaks stay intact
  const pasted = "satır bir\nsatır iki\r\n  üçüncü  satır\n$(dördüncü) \"satır\"";
  const expected = `\x1b[200~${pasted.replace(/\r?\n/g, "\r")}\x1b[201~`;
  await cdp.evaluate(`window.agentyard.invoke("clipboard-write-text", ${JSON.stringify(pasted)})`);
  await cdp.send("Input.dispatchMouseEvent", {type: "mousePressed", x: pos.x, y: pos.y, button: "right", clickCount: 1});
  await cdp.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: pos.x, y: pos.y, button: "right", clickCount: 1});
  const pasteOk = await waitFor(() => log().includes(expected), "the pasted text in the PTY", 8000).catch(() => false);
  results.check("right-click paste keeps the order and the lines (bracketed)", !!pasteOk, pasteOk ? undefined : log().slice(-300));

  // A clipboard that tries to leave the bracketed paste, through both paste routes
  const hostile = "smoke-hostile\x1b[201~smoke-escaped\n";
  const cleaned = "\x1b[200~smoke-hostile[201~smoke-escaped\r\x1b[201~";
  const logBeforeRightClick = log().length;
  await cdp.evaluate(`window.agentyard.invoke("clipboard-write-text", ${JSON.stringify(hostile)})`);
  await cdp.send("Input.dispatchMouseEvent", {type: "mousePressed", x: pos.x, y: pos.y, button: "right", clickCount: 1});
  await cdp.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: pos.x, y: pos.y, button: "right", clickCount: 1});
  const rightClickClean = await waitFor(() => log().slice(logBeforeRightClick).includes(cleaned), "the cleaned right-click paste", 8000).catch(() => false);
  results.check("right-click paste cannot leave the bracketed paste", !!rightClickClean, rightClickClean ? undefined : log().slice(-300));
  const logBeforeEvent = log().length;
  await cdp.evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(hostile)});
    const area = [...document.querySelectorAll(".xterm-helper-textarea")].find(t => t.offsetParent !== null);
    area.dispatchEvent(new ClipboardEvent("paste", {clipboardData: data, bubbles: true, cancelable: true}));
  })()`);
  const eventClean = await waitFor(() => log().slice(logBeforeEvent).includes(cleaned), "the cleaned paste event", 8000).catch(() => false);
  results.check("paste event cannot leave the bracketed paste", !!eventClean, eventClean ? undefined : log().slice(-300));
  results.check("paste event reaches the PTY once", log().slice(logBeforeEvent).split(cleaned).length === 2);

  // Real File through a real drop: webUtils.getPathForFile needs a browser-made File
  const dropDir = path.join(home, "Boşluklu Klasör şğüöçıİ");
  fs.mkdirSync(dropDir);
  const dropped = path.join(dropDir, "Sürüklenen Dosya ÇĞ.txt");
  fs.writeFileSync(dropped, "smoke\n");
  const {buildPathPaste} = require(path.join(REPO, "dist", "attach-paste.js"));
  const data = {items: [], files: [dropped], dragOperationsMask: 1};
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", {type, x: pos.x, y: pos.y, data});
  }
  const dropOk = await waitFor(() => log().includes(buildPathPaste([dropped])), "the dropped path in the PTY", 8000).catch(() => false);
  results.check("dropped file gives the right path, with spaces and Turkish characters", !!dropOk, dropOk ? dropped : log().slice(-300));

  return created;
}

// A reload re-runs the preload and the renderer while the PTY lives on in main: IPC, the preload API,
// the terminal and the keyboard path must all work again, with real output as the evidence.
async function checkReload(cdp, results, home, created) {
  const log = () => { try { return fs.readFileSync(path.join(home, STUB_LOG), "utf8"); } catch { return ""; } };
  await cdp.send("Page.reload");
  await waitFor(() => cdp.evaluate(`!!document.querySelector(".sidebar") && !!window.agentyard`), "the page after reload");
  results.check("preload API is present after reload", await cdp.evaluate(`typeof window.agentyard.invoke === "function"`));
  const sessions = await cdp.evaluate(`window.agentyard.invoke("get-all-sessions")`);
  results.check("invoke works after reload", Array.isArray(sessions) && sessions.some(s => s.id === created.id), sessions.map?.(s => s.id));

  // The new xterm starts empty (the PTY's earlier output is not replayed), so "drawn" means: the
  // session's tab is back and selecting it shows a visible terminal with rows
  const tabSelector = JSON.stringify(`#tabs .tab[data-session-id="${created.id}"]`);
  await waitFor(() => cdp.evaluate(`!!document.querySelector(${tabSelector})`), "the session's tab after reload", 30000);
  await cdp.evaluate(`document.querySelector(${tabSelector}).click(); 1`);
  const visibleTerminal = `(() => {
    for (const el of document.querySelectorAll(".xterm")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && el.querySelectorAll(".xterm-rows > div").length > 0) return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    }
    return null;
  })()`;
  const pos = await waitFor(() => cdp.evaluate(visibleTerminal), "a visible terminal with rows after reload", 30000);
  results.check("the session's terminal is drawn again after reload", !!pos, pos);
  await cdp.send("Input.dispatchMouseEvent", {type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1});
  await cdp.send("Input.dispatchMouseEvent", {type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1});
  await cdp.send("Input.insertText", {text: "smoke-after-reload"});
  await waitFor(() => log().includes("smoke-after-reload"), "typed input in the PTY after reload");
  await waitFor(() => cdp.evaluate(`${textOfTerminals}.includes("smoke-after-reload")`), "the echo of the post-reload input in xterm");
  results.check("typed input reaches the PTY and its echo is drawn after reload", true);
}

function checkRejections(app, results, expectRogue) {
  const lines = app.output.split("\n").filter(l => l.includes("Rejected IPC"));
  const unexpected = lines.filter(l => !expectRogue || !l.includes("rogue.html"));
  results.check("the trusted page had no IPC rejected", unexpected.length === 0, unexpected.slice(0, 3));
}

function checkConsole(app, results) {
  // The deliberate attacks above are the only errors allowed
  const allowed = /x:\/\/bad|inline|unsafe-eval|EvalError|example\.com/;
  const unexpected = app.consoleErrors.filter(e => !allowed.test(e));
  results.check("no unexpected page errors", unexpected.length === 0, unexpected.slice(0, 5));
}

async function run(results, {packaged, home, tempRoot}) {
  const scratch = path.join(tempRoot, "pages");
  fs.mkdirSync(scratch);
  const roguePage = path.join(scratch, "rogue.html");
  fs.writeFileSync(roguePage, "<!doctype html><title>rogue</title>");
  const probePreload = path.join(scratch, "probe-preload.js");
  fs.writeFileSync(probePreload, `
    const {contextBridge} = require("electron");
    let fsLoaded = false;
    try { require("fs"); fsLoaded = true; } catch {}
    contextBridge.exposeInMainWorld("probe", {fsLoaded, sandboxed: process.sandboxed === true});
  `);

  seedHome(home);
  const electronBinary = require(path.join(REPO, "node_modules", "electron"));
  const entries = seededStorageEntries();

  // localStorage as the old window settings wrote it, for each possible userData folder
  for (const name of userDataNames()) {
    const [seedFile, seedArgs] = displayCommand(electronBinary, ["--no-sandbox", __filename, "--seed-storage"]);
    const seeder = childProcess.spawnSync(seedFile, seedArgs, {
      env: childEnv(home, {
        SMOKE_USER_DATA: path.join(home, ".config", name),
        SMOKE_SEED_PAGE: roguePage,
        SMOKE_SEED_ENTRIES: JSON.stringify(entries),
      }),
      cwd: home,
      timeout: 30000,
      encoding: "utf8",
    });
    if (seeder.status !== 0) throw new Error(`Seeding localStorage failed (${seeder.status}): ${seeder.stderr}`);
  }

  let launchSpec;
  let appDir = REPO;
  if (packaged) {
    const source = path.join(REPO, "dist", "linux-unpacked");
    if (!fs.existsSync(path.join(source, "agentyard"))) throw new Error("dist/linux-unpacked/agentyard is missing: run npm run pack");
    appDir = path.join(tempRoot, "Çalışma Dizini", "paket");
    fs.mkdirSync(path.dirname(appDir), {recursive: true});
    fs.cpSync(source, appDir, {recursive: true, verbatimSymlinks: true});
    launchSpec = {binary: path.join(appDir, "agentyard"), args: ["--no-sandbox", "--remote-debugging-port=0"]};
  } else {
    launchSpec = {binary: electronBinary, args: ["-r", __filename, "--no-sandbox", "--remote-debugging-port=0", REPO]};
  }
  const env = childEnv(home, {SMOKE_ROGUE_PAGE: roguePage, SMOKE_PROBE_PRELOAD: probePreload});
  // Both launch specs pass --no-sandbox (chrome-sandbox is not SUID here), so the OS layer is never exercised
  if (launchSpec.args.includes("--no-sandbox")) {
    results.skip(`OS sandbox layer of sandbox: true (${packaged ? "packaged" : "checkout"})`, "--no-sandbox is used; only the JS layer (no Node in the page or the preload) is checked");
  }

  console.log(`--- First start (${packaged ? "packaged" : "checkout"}): saved data, isolation, UI`);
  let created;
  const first = await startApp({...launchSpec, env});
  try {
    const url = await first.cdp.evaluate("location.href");
    const expectedUrl = pathToFileURL(path.join(appDir, ...(packaged ? ["resources", "app.asar"] : []), "index.html")).href;
    results.check("page URL is index.html where the app lives", url === expectedUrl, url);
    await waitFor(() => first.cdp.evaluate(`!!document.querySelector(".sidebar") && !!window.agentyard`), "the page");

    await checkIsolation(first.cdp, results, home);
    await checkSeededData(first.cdp, results, entries);
    // xterm draws in requestAnimationFrame: without frames PTY output arrives but never reaches the DOM
    results.check("the page gets animation frames", await first.cdp.evaluate(`new Promise(r => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), 2000); })`));
    created = await checkNewSession(first.cdp, results, home);
    await checkReload(first.cdp, results, home, created);

    if (packaged) {
      results.skip("rejected sender and preload probe in the packaged binary", "a packaged binary takes no -r, so no second window can be opened from outside; both run in the checkout run, and the same code path accepted the asar URL here");
      results.skip("real-HOME guard inside the packaged binary", "same reason; the parent still refuses and sets HOME itself");
    } else {
      await waitFor(() => first.electron.preloadProbe || first.electron.rogueError, "the checks inside Electron");
      const {mainPrefs, rogue, preloadProbe, rogueError} = first.electron;
      results.check("Electron-side checks ran", !rogueError, rogueError);
      results.check("main window runs isolated, as main reports it", mainPrefs?.nodeIntegration === false && mainPrefs?.contextIsolation === true && mainPrefs?.sandbox === true, mainPrefs);
      results.check("invoke from another file:// page is rejected", typeof rogue?.invoke?.rejected === "string" && !("resolved" in rogue.invoke), rogue?.invoke);
      results.check("both rejected messages were logged with channel and URL", ["get-home-dir", "session-input"].every(c => rogue?.rejected?.some(l => l.includes(c) && l.includes("rogue.html"))), rogue?.rejected);
      results.check("a sandbox: true preload cannot load Node modules", preloadProbe?.fsLoaded === false, preloadProbe);
    }
    checkRejections(first, results, !packaged);
    checkConsole(first, results);
  } finally {
    await stopApp(first);
  }

  console.log("--- Second start: the layout saved by the isolated renderer reloads");
  const second = await startApp({...launchSpec, env});
  try {
    await waitFor(() => second.cdp.evaluate(`!!window.agentyard`), "the page");
    const sessions = await waitFor(async () => {
      const all = await second.cdp.evaluate(`window.agentyard.invoke("get-all-sessions")`);
      return all.length >= 2 ? all : null;
    }, "the saved sessions");
    results.check("seeded and new sessions are saved across a restart", sessions.some(s => s.id === SEEDED_ID), sessions.map(s => s.name));
    const stored = await second.cdp.evaluate(`localStorage.getItem("sidebarWidth")`);
    results.check("localStorage survives the restart", stored === SEEDED_STORAGE.sidebarWidth, stored);
    await waitFor(() => second.cdp.evaluate(`document.querySelectorAll(".xterm-rows").length > 0`), "a terminal in the restored panes", 30000);
    const restored = JSON.parse(await second.cdp.evaluate(`localStorage.getItem("workspaces")`));
    // Only the first start's renderer can have put this session in the layout: the seed does not know it
    const saved = JSON.stringify({panes: restored.workspaces.map(w => w.panes), membership: restored.membership});
    results.check("the layout saved by the isolated renderer reloads", saved.includes(created.id), {created: created.id, root: restored.workspaces[0].panes.root, membership: restored.membership});
    checkRejections(second, results, !packaged);
    checkConsole(second, results);
  } finally {
    await stopApp(second);
  }
}

async function main() {
  const packaged = process.argv.includes("--packaged");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentyard-smoke-"));
  const home = path.join(tempRoot, "home");
  fs.mkdirSync(home);
  if (path.resolve(home) === path.resolve(os.userInfo().homedir)) throw new Error("Temp home equals the real home");

  const results = new Results();
  let crash;
  const overall = setTimeout(() => {
    console.error("smoke-isolation: overall timeout");
    if (liveChild) killGroup(liveChild, "SIGKILL");
    fs.rmSync(tempRoot, {recursive: true, force: true});
    process.exit(2);
  }, TIMEOUT_MS);
  try {
    await run(results, {packaged, home, tempRoot});
  } catch (error) {
    crash = error;
  }
  clearTimeout(overall);
  fs.rmSync(tempRoot, {recursive: true, force: true, maxRetries: 5, retryDelay: 300});

  if (crash) console.error(`FAIL smoke stopped early: ${crash.stack ?? crash}`);
  console.log(`Temp dir removed: ${!fs.existsSync(tempRoot)}`);
  console.log(`${results.failed === 0 && !crash ? "OK" : "FAILED"}: ${results.failed} failed check(s)${crash ? ", stopped early" : ""}; not tested: ${results.notTested.length}`);
  process.exit(results.failed === 0 && !crash ? 0 : 1);
}

if (process.versions.electron) {
  refuseRealHome();
  if (process.argv.includes("--seed-storage")) seedStorageInElectron();
  else rogueChecksInElectron();
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
