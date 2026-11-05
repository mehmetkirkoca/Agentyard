import * as fs from "fs";
import * as path from "path";
import {hardenNavigation} from "./window-security";

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
