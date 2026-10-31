import {isTerminalReportOnly, nextStatus, parseHookEvents, statusOnAppQuit, statusOnUserInput, statusOnView} from "./session-status";
import {SessionStatus} from "./types";

const ev = (hook_event_name: string, notification_type?: string) => ({hook_event_name, session_id: "s", notification_type});

describe("parseHookEvents", () => {
  it("parses one event per line", () => {
    const text = '{"hook_event_name":"Stop","session_id":"a"}\n\n{"hook_event_name":"PostToolUse","session_id":"a"}\n';
    expect(parseHookEvents(text).map(e => e.hook_event_name)).toEqual(["Stop", "PostToolUse"]);
  });

  it("skips blank and broken lines", () => {
    const text = '\n{broken\n{"hook_event_name":"Stop","session_id":"a"}\n   \n{"x":1}\n';
    expect(parseHookEvents(text)).toHaveLength(1);
  });
});

describe("nextStatus", () => {
  it("UserPromptSubmit -> running", () => {
    expect(nextStatus(SessionStatus.IDLE, ev("UserPromptSubmit"), true)).toBe(SessionStatus.RUNNING);
  });
  it("PostToolUse -> running", () => {
    expect(nextStatus(SessionStatus.WAITING, ev("PostToolUse"), false)).toBe(SessionStatus.RUNNING);
  });
  it("Stop -> done when not viewed", () => {
    expect(nextStatus(SessionStatus.RUNNING, ev("Stop"), false)).toBe(SessionStatus.DONE);
  });
  it("Stop -> idle when viewed", () => {
    expect(nextStatus(SessionStatus.RUNNING, ev("Stop"), true)).toBe(SessionStatus.IDLE);
  });
  it("idle_prompt -> done when not viewed", () => {
    expect(nextStatus(SessionStatus.IDLE, ev("Notification", "idle_prompt"), false)).toBe(SessionStatus.DONE);
  });
  it("idle_prompt -> idle when viewed", () => {
    expect(nextStatus(SessionStatus.DONE, ev("Notification", "idle_prompt"), true)).toBe(SessionStatus.IDLE);
  });
  it("permission_prompt -> waiting", () => {
    expect(nextStatus(SessionStatus.RUNNING, ev("Notification", "permission_prompt"), true)).toBe(SessionStatus.WAITING);
  });
  it("other notifications -> waiting", () => {
    expect(nextStatus(SessionStatus.RUNNING, ev("Notification"), false)).toBe(SessionStatus.WAITING);
  });
  it("unknown event keeps current status", () => {
    expect(nextStatus(SessionStatus.DONE, ev("SessionStart"), false)).toBe(SessionStatus.DONE);
  });
  it("unknown event with no status -> idle", () => {
    expect(nextStatus(undefined, ev("SessionStart"), false)).toBe(SessionStatus.IDLE);
  });
});

describe("statusOnView", () => {
  it("done -> idle", () => {
    expect(statusOnView(SessionStatus.DONE)).toBe(SessionStatus.IDLE);
  });
  it("waiting stays waiting when viewed", () => {
    expect(statusOnView(SessionStatus.WAITING)).toBe(SessionStatus.WAITING);
  });
  it("running and undefined unchanged", () => {
    expect(statusOnView(SessionStatus.RUNNING)).toBe(SessionStatus.RUNNING);
    expect(statusOnView(undefined)).toBeUndefined();
  });
});

describe("statusOnAppQuit", () => {
  it("running and waiting -> done", () => {
    expect(statusOnAppQuit(SessionStatus.RUNNING)).toBe(SessionStatus.DONE);
    expect(statusOnAppQuit(SessionStatus.WAITING)).toBe(SessionStatus.DONE);
  });
  it("others unchanged", () => {
    expect(statusOnAppQuit(SessionStatus.DONE)).toBe(SessionStatus.DONE);
    expect(statusOnAppQuit(SessionStatus.IDLE)).toBe(SessionStatus.IDLE);
    expect(statusOnAppQuit(undefined)).toBeUndefined();
  });
});

describe("statusOnUserInput", () => {
  it("waiting -> idle", () => {
    expect(statusOnUserInput(SessionStatus.WAITING)).toBe(SessionStatus.IDLE);
  });
  it("others unchanged", () => {
    expect(statusOnUserInput(SessionStatus.RUNNING)).toBe(SessionStatus.RUNNING);
    expect(statusOnUserInput(SessionStatus.DONE)).toBe(SessionStatus.DONE);
    expect(statusOnUserInput(undefined)).toBeUndefined();
  });
});

describe("isTerminalReportOnly", () => {
  it("focus in/out, CPR, DA, DSR and OSC replies are reports", () => {
    for (const data of ["\x1b[I", "\x1b[O", "\x1b[I\x1b[O", "\x1b[12;40R", "\x1b[?1;2c", "\x1b[>0;276;0c",
      "\x1b[0n", "\x1b[?2026;2$y", "\x1b]11;rgb:0000/0000/0000\x07", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"]) {
      expect(isTerminalReportOnly(data)).toBe(true);
    }
  });

  it("keystrokes are user input", () => {
    for (const data of ["", "y", "\r", "\x1b", "\x1b[A", "\x1b[B", "\x03", "\x1b[Ix", "1"]) {
      expect(isTerminalReportOnly(data)).toBe(false);
    }
  });
});
