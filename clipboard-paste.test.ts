import {pasteFromClipboard} from "./clipboard-paste";

describe("pasteFromClipboard", () => {
  it("passes multi-line text through unchanged", async () => {
    const paste = jest.fn();
    const text = "line one\r\n  indented\nlast line\n";
    await pasteFromClipboard(async () => text, paste, jest.fn());
    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith(text);
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
