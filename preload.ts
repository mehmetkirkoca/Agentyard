import {contextBridge, ipcRenderer, webUtils} from "electron";
import {exposeAgentyardApi, pickBridge} from "./ipc-channels";

// Only contextBridge, ipcRenderer and webUtils: the sandboxed preload can load nothing else.
exposeAgentyardApi(
  pickBridge(process.contextIsolated, contextBridge, window as unknown as Record<string, unknown>),
  ipcRenderer,
  webUtils,
);
