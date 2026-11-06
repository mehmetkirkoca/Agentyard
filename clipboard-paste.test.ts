import {pasteFromClipboard, sanitizePaste} from "./clipboard-paste";

describe("sanitizePaste", () => {
  it("removes what could end a bracketed paste, including the 8-bit CSI", () => {
    expect(sanitizePaste("a\x1b[201~b")).toBe("a[201~b");
    expect(sanitizePaste("a\x9b201~b")).toBe("a201~b");
  });

  it("keeps tabs, line breaks and Turkish characters", () => {
    const text = "şğüöçıİ\tx\r\n  y\nz";
    expect(sanitizePaste(text)).toBe(text);
  });
});

describe("pasteFromClipboard", () => {
  it("passes multi-line text through unchanged", async () => {
    const paste = jest.fn();
    const text = "line one\r\n  indented\nlast line\n";
    await pasteFromClipboard(async () => text, paste, jest.fn());
    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith(text);
  });

  it("cleans a clipboard that tries to leave the bracketed paste", async () => {
    const paste = jest.fn();
    await pasteFromClipboard(async () => "ok\x1b[201~\nrm -rf x\n", paste, jest.fn());
    expect(paste).toHaveBeenCalledWith("ok[201~\nrm -rf x\n");
  });

  it("does not paste when the clipboard is empty", async () => {
    const paste = jest.fn();
    const onError = jest.fn();
    await pasteFromClipboard(async () => "", paste, onError);
    expect(paste).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports the error message when reading fails", async () => {
    const paste = jest.fn();
    const onError = jest.fn();
    await pasteFromClipboard(async () => { throw new Error("clipboard unavailable"); }, paste, onError);
    expect(paste).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("clipboard unavailable");
  });

  it("stringifies a non-Error rejection", async () => {
    const onError = jest.fn();
    await pasteFromClipboard(() => Promise.reject("boom"), jest.fn(), onError);
    expect(onError).toHaveBeenCalledWith("boom");
  });
});
