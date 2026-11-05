import {contextBridge, ipcRenderer, webUtils} from "electron";
import {exposeAgentyardApi} from "./ipc-channels";

// Only contextBridge, ipcRenderer and webUtils: the sandboxed preload can load nothing else.
exposeAgentyardApi(contextBridge, ipcRenderer, webUtils);
