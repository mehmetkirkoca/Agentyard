import type {IpcMainEvent, IpcMainInvokeEvent} from "electron";

// Any other page loaded into the window would get the preload API, which writes to terminals:
// the window stays on index.html and opens nothing else.
export function hardenNavigation(contents: {
  on(event: "will-navigate", listener: (event: {preventDefault(): void}) => void): unknown;
  setWindowOpenHandler(handler: () => {action: "deny"}): void;
}): void {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({action: "deny"}));
}

// indexHtmlUrl is the URL the window was told to load. A fragment stays on the same document (a
// click on an href="#" link adds one) and fires no will-navigate; a query is another document.
export function isTrustedSender(frameUrl: string | undefined, indexHtmlUrl: string): boolean {
  if (!frameUrl) return false;
  const fragment = frameUrl.indexOf("#");
  return (fragment === -1 ? frameUrl : frameUrl.slice(0, fragment)) === indexHtmlUrl;
}

type SenderEvent = {senderFrame?: {url: string} | null};

// senderFrame is null once the frame navigated or was destroyed, and reading a disposed frame can throw
function senderUrl(event: SenderEvent): string | undefined {
  try {
    return event.senderFrame?.url;
  } catch {
    return undefined;
  }
}

export interface TrustedIpc {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void;
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): unknown;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
}

// The only way main.ts registers IPC (window-security.test.ts scans for ipcMain): every message is
// checked against index.html before its listener runs. A rejected handle throws back to the
// caller; a rejected on message has nobody waiting, so it is only logged.
export function createTrustedIpc(
  ipc: IpcMainLike,
  indexHtmlUrl: string,
  log: (message: string) => void = console.warn,
): TrustedIpc {
  const rejected = (channel: string, event: SenderEvent): boolean => {
    const url = senderUrl(event);
    if (isTrustedSender(url, indexHtmlUrl)) return false;
    log(`Rejected IPC on "${channel}" from untrusted sender: ${url ?? "(no frame)"}`);
    return true;
  };
  return {
    handle(channel, listener) {
      ipc.handle(channel, (event, ...args) => {
        if (rejected(channel, event)) throw new Error(`IPC on "${channel}" rejected: untrusted sender`);
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      ipc.on(channel, (event, ...args) => {
        if (rejected(channel, event)) return;
        listener(event, ...args);
      });
    },
  };
}
