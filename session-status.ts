import {SessionStatus} from "./types";

export interface HookEvent {
  hook_event_name: string;
  /** Claude Code and Gemini CLI */
  session_id?: string;
  notification_type?: string;
  /** Antigravity CLI: its conversation id, and on Stop whether it is fully idle */
  conversationId?: string;
  fullyIdle?: boolean;
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
    // Claude Code: UserPromptSubmit/PostToolUse, Gemini CLI: BeforeAgent/AfterTool,
    // Antigravity CLI: PreInvocation/PostToolUse. Its PreToolUse is left out: it comes right before
    // the approval screen, and read late from the status file it would undo WAITING.
    case "UserPromptSubmit":
    case "PostToolUse":
    case "BeforeAgent":
    case "AfterTool":
    case "PreInvocation":
      return SessionStatus.RUNNING;
    // Gemini CLI sends notification_type "ToolPermission" while it waits for approval
    case "Notification":
      return ev.notification_type === "idle_prompt" ? finished : SessionStatus.WAITING;
    // Antigravity sends fullyIdle: false when work goes on in the background
    case "Stop":
      return ev.fullyIdle === false ? current ?? SessionStatus.RUNNING : finished;
    case "AfterAgent":
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
