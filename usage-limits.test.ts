import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {findUserStatusLine} from "./claude-launch";
import {
  formatAgo,
  formatResetIn,
  limitLevel,
  parseClaudeLimits,
  STALE_AFTER_MS,
  windowView,
} from "./usage-limits";

const MIN = 60_000;
const NOW = Date.parse("2026-11-11T15:00:00Z");

describe("parseClaudeLimits", () => {
  const status = (rateLimits: unknown) => JSON.stringify({model: {id: "claude-opus-5-5"}, cwd: "/w", rate_limits: rateLimits});

  it("reads the 5-hour and the weekly window, resets in seconds or milliseconds", () => {
    const limits = parseClaudeLimits(status({
      five_hour: {used_percentage: 42.4, resets_at: 1794410280},
      seven_day: {used_percentage: 18, resets_at: 1794700000000},
    }), NOW);
    expect(limits).toEqual({
      tool: "claude",
      readAt: NOW,
      fiveHour: {usedPercent: 42.4, resetsAt: 1794410280000},
      week: {usedPercent: 18, resetsAt: 1794700000000},
    });
  });

  it("takes an ISO reset time and keeps a window without one", () => {
    const limits = parseClaudeLimits(status({five_hour: {used_percentage: 5, resets_at: "2026-11-11T17:58:00Z"}, seven_day: {used_percentage: 1}}), NOW);
    expect(limits?.fiveHour).toEqual({usedPercent: 5, resetsAt: Date.parse("2026-11-11T17:58:00Z")});
    expect(limits?.week).toEqual({usedPercent: 1});
  });

  it("clamps the percentage to 0..100", () => {
    const limits = parseClaudeLimits(status({five_hour: {used_percentage: 130}, seven_day: {used_percentage: -3}}), NOW);
    expect(limits?.fiveHour?.usedPercent).toBe(100);
    expect(limits?.week?.usedPercent).toBe(0);
  });

  it("returns undefined without usable windows or for broken JSON", () => {
    expect(parseClaudeLimits(status(undefined), NOW)).toBeUndefined();
    expect(parseClaudeLimits(status({five_hour: {used_percentage: "x"}}), NOW)).toBeUndefined();
    expect(parseClaudeLimits("{broken", NOW)).toBeUndefined();
    expect(parseClaudeLimits("", NOW)).toBeUndefined();
  });
});

describe("limitLevel", () => {
  it("is ok below 50, warn up to 80, high from 80", () => {
    expect(limitLevel(0)).toBe("ok");
    expect(limitLevel(49.9)).toBe("ok");
    expect(limitLevel(50)).toBe("warn");
    expect(limitLevel(79.9)).toBe("warn");
    expect(limitLevel(80)).toBe("high");
    expect(limitLevel(100)).toBe("high");
  });
});

describe("windowView", () => {
  it("shows the level while the window runs", () => {
    expect(windowView({usedPercent: 91, resetsAt: NOW + 25 * MIN}, NOW, NOW)).toEqual({state: "live", level: "high", percent: 91});
  });

  it("says reset once the reset time has passed", () => {
    expect(windowView({usedPercent: 91, resetsAt: NOW - MIN}, NOW - 2 * MIN, NOW)).toEqual({state: "reset", level: "ok", percent: 0});
  });

  it("is stale when the reading is old", () => {
    expect(windowView({usedPercent: 63}, NOW - STALE_AFTER_MS - 1, NOW)).toEqual({state: "stale", level: "warn", percent: 63});
    expect(windowView({usedPercent: 63}, NOW - STALE_AFTER_MS + 1, NOW).state).toBe("live");
  });
});

describe("formatResetIn and formatAgo", () => {
  it("formats the time to a reset", () => {
    expect(formatResetIn(NOW + 80 * MIN, NOW)).toBe("1h 20m");
    expect(formatResetIn(NOW + 25 * MIN, NOW)).toBe("25m");
    expect(formatResetIn(NOW + 30_000, NOW)).toBe("<1m");
    expect(formatResetIn(NOW + (2 * 24 * 60 + 3 * 60) * MIN, NOW)).toBe("2d 3h");
    expect(formatResetIn(NOW - MIN, NOW)).toBe("now");
  });

  it("formats the age of a reading", () => {
    expect(formatAgo(NOW - 20_000, NOW)).toBe("just now");
    expect(formatAgo(NOW - 2 * MIN, NOW)).toBe("2m ago");
    expect(formatAgo(NOW - 3 * 60 * MIN, NOW)).toBe("3h ago");
    expect(formatAgo(NOW - 2 * 24 * 60 * MIN, NOW)).toBe("2d ago");
  });
});

describe("findUserStatusLine", () => {
  let root: string;
  let home: string;
  let project: string;
  const OWN = "/app/.agentyard/statusline.sh";
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-"));
    home = path.join(root, "home");
    project = path.join(root, "proje");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
  });
  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  it("finds none without settings", () => {
    expect(findUserStatusLine(project, home, OWN)).toBeUndefined();
  });

  it("takes the user's status line, with its padding", () => {
    write(path.join(home, ".claude", "settings.json"), {statusLine: {type: "command", command: "~/bin/line.sh", padding: 0}});
    expect(findUserStatusLine(project, home, OWN)).toEqual({command: "~/bin/line.sh", padding: 0});
  });

  it("prefers the project's local settings, then the project's, then the user's", () => {
    write(path.join(home, ".claude", "settings.json"), {statusLine: {type: "command", command: "user"}});
    write(path.join(project, ".claude", "settings.json"), {statusLine: {type: "command", command: "shared"}});
    expect(findUserStatusLine(project, home, OWN)?.command).toBe("shared");
    write(path.join(project, ".claude", "settings.local.json"), {statusLine: {type: "command", command: "local"}});
    expect(findUserStatusLine(project, home, OWN)?.command).toBe("local");
  });

  it("skips broken files, other types, empty commands and Agentyard's own script", () => {
    write(path.join(project, ".claude", "settings.local.json"), "{broken");
    write(path.join(project, ".claude", "settings.json"), {statusLine: {type: "static", command: "x"}});
    write(path.join(home, ".claude", "settings.json"), {statusLine: {type: "command", command: `sh '${OWN}'`}});
    expect(findUserStatusLine(project, home, OWN)).toBeUndefined();
    write(path.join(home, ".claude", "settings.json"), {statusLine: {type: "command", command: "  "}});
    expect(findUserStatusLine(project, home, OWN)).toBeUndefined();
  });
});
