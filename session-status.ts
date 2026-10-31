import {SessionStatus} from "./types";

export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  notification_type?: string;
}

/**
 * Parse JSONL hook output line by line. Blank, broken or incomplete-shaped lines are skipped.
 */
export function parseHookEvents(text: string): HookEvent[] {
  const events: HookEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.hook_event_name === "string") {
        events.push(parsed as HookEvent);
      }
    } catch {
      // skip unparseable line
    }
  }
  return events;
}

/**
 * Status transition for a single hook event.
 * Unknown events keep the current status (IDLE when there is none).
 */
export function nextStatus(current: SessionStatus | undefined, ev: HookEvent, isViewed: boolean): SessionStatus {
  const finished = isViewed ? SessionStatus.IDLE : SessionStatus.DONE;
  switch (ev.hook_event_name) {
    case "UserPromptSubmit":
    case "PostToolUse":
      return SessionStatus.RUNNING;
    case "Notification":
      return ev.notification_type === "idle_prompt" ? finished : SessionStatus.WAITING;
    case "Stop":
      return finished;
    default:
      return current ?? SessionStatus.IDLE;
  }
}

/** Viewing a finished session acknowledges it. WAITING stays WAITING. */
export function statusOnView(current: SessionStatus | undefined): SessionStatus | undefined {
  return current === SessionStatus.DONE ? SessionStatus.IDLE : current;
}

/** On app quit, in-flight sessions become DONE so the user sees they need attention. */
export function statusOnAppQuit(current: SessionStatus | undefined): SessionStatus | undefined {
  return current === SessionStatus.RUNNING || current === SessionStatus.WAITING ? SessionStatus.DONE : current;
}

/**
 * Rejecting a permission prompt fires no Stop hook, so user input while WAITING resets to IDLE.
 * Hooks drive the status again afterwards.
 */
export function statusOnUserInput(current: SessionStatus | undefined): SessionStatus | undefined {
  return current === SessionStatus.WAITING ? SessionStatus.IDLE : current;
}

// Replies xterm sends on its own, not keystrokes: focus in/out (CSI I / CSI O), cursor position
// reports (CSI row;col R), device attributes (CSI ? ... c / CSI > ... c), device status (CSI n),
// mode reports (CSI ? ... $ y) and OSC replies (e.g. colour queries).
const TERMINAL_REPORT_RE =
  /^(?:\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\[\d*n|\x1b\[\?[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

/**
 * Whether terminal input consists only of terminal-generated reports (focus changes, DA/CPR
 * replies) rather than anything the user typed. Such input must not reset WAITING. A lone ESC,
 * arrow keys and every other key are user input.
 */
export function isTerminalReportOnly(data: string): boolean {
  return TERMINAL_REPORT_RE.test(data);
}
