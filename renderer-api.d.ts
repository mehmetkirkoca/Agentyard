import type {AgentyardApi} from "./ipc-channels";

declare global {
  interface Window {
    agentyard: AgentyardApi;
  }
}

export {};
