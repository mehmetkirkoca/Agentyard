import {currentPromptIndex, findPromptRows, hasJumpToBottom, seekStep} from "./sticky-prompt";

describe("findPromptRows", () => {
  it("matches echoed prompt rows to transcript prompts", () => {
    const lines = [
      "❯ ilk soru",
      "● cevap",
      "❯ ikinci   soru",
      "  devam satırı",
      "● cevap",
    ];
    expect(findPromptRows(lines, ["ilk soru", "ikinci soru\ndevam satırı"])).toEqual([
      {row: 0, index: 0},
      {row: 2, index: 1},
    ]);
  });

  it("matches a prompt whose first line wrapped onto several rows", () => {
    expect(findPromptRows(["❯ uzun bir soru ki", "  satıra sığmadı"], ["uzun bir soru ki satıra sığmadı"]))
      .toEqual([{row: 0, index: 0}]);
  });

  it("ignores glyph rows that match no prompt, like the input box", () => {
    expect(findPromptRows(["❯ ", "❯ yazılıyor", "> alıntı"], ["soru"])).toEqual([]);
  });

  it("prefers an exact match over a longer prompt sharing the prefix", () => {
    expect(findPromptRows(["❯ devam"], ["devam", "devam et"])).toEqual([{row: 0, index: 0}]);
  });

  it("aligns from the bottom so repeated prompts map to the latest ones", () => {
    expect(findPromptRows(["❯ devam", "x", "❯ devam"], ["devam", "başka", "devam"])).toEqual([
      {row: 0, index: 0},
      {row: 2, index: 2},
    ]);
  });
});

describe("hasJumpToBottom", () => {
  it("finds the indicator drawn over a content row above the input box", () => {
    expect(hasJumpToBottom([
      "442 +    for (let i = 0; i < buffer.length; i++) {       Jump to bottom (ctrl+End) ↓",
      "",
      "────────",
      "❯ yazılıyor",
      "────────",
      "⏵⏵ bypass permissions on (shift+tab to cycle)",
    ])).toBe(true);
  });

  it("finds every variant Claude Code renders", () => {
    expect(hasJumpToBottom(["  3 new messages (ctrl+End) ↓"])).toBe(true);
    expect(hasJumpToBottom(["  1 new message (click) ↓"])).toBe(true);
    expect(hasJumpToBottom(["  Jump to bottom ↓"])).toBe(true);
    expect(hasJumpToBottom(["  Jump to bottom: fn+↓ to scroll"])).toBe(true);
  });

  it("finds the indicator centred over a content row that runs on past it", () => {
    expect(hasJumpToBottom([
      "const lines = visibleLines();     Jump to bottom (ctrl+End) ↓     // rest of the long row",
    ])).toBe(true);
  });

  it("ignores the phrase without the indicator's arrow or scroll hint", () => {
    expect(hasJumpToBottom(["Jump to bottom yazısı görünüyor"])).toBe(false);
    expect(hasJumpToBottom(["3 new messages geldi"])).toBe(false);
  });
});

describe("currentPromptIndex", () => {
  const prompts = ["bir", "iki", "üç"];

  it("is the last prompt while not scrolled up", () => {
    expect(currentPromptIndex(["❯ bir", "x"], prompts, false, 0)).toBe(2);
  });

  it("is the prompt before the first one on screen", () => {
    expect(currentPromptIndex(["", "cevap", "❯ üç", "cevap"], prompts, true, null)).toBe(1);
  });

  it("is the prompt on the top row itself, such as Claude Code's own sticky header", () => {
    expect(currentPromptIndex(["❯ iki", "cevap", "❯ üç"], prompts, true, null)).toBe(1);
  });

  it("is the prompt right under the top row, where a scroll to it lands", () => {
    expect(currentPromptIndex(["", "❯ iki", "cevap", "❯ üç"], prompts, true, null)).toBe(1);
    expect(currentPromptIndex(["", "", "❯ iki"], prompts, true, null)).toBe(0);
  });

  it("is nothing above the first prompt", () => {
    expect(currentPromptIndex(["", "karşılama", "❯ bir"], prompts, true, 2)).toBeNull();
  });

  it("keeps the previous prompt while no prompt is on screen", () => {
    expect(currentPromptIndex(["uzun", "cevap"], prompts, true, 1)).toBe(1);
    expect(currentPromptIndex(["uzun", "cevap"], prompts, true, 9)).toBe(2);
    expect(currentPromptIndex(["uzun", "cevap"], prompts, true, null)).toBeNull();
  });

  it("is nothing without prompts", () => {
    expect(currentPromptIndex([], [], false, null)).toBeNull();
  });
});

describe("seekStep", () => {
  const prompts = ["bir", "iki", "üç", "dört"];
  const seek = (lines: string[], target: number, opts: {skipRows?: number; scrolledUp?: boolean; current?: number | null} = {}) =>
    seekStep(lines, prompts, target, opts.skipRows ?? 0, opts.scrolledUp ?? true, opts.current ?? null);

  it("is done once the target sits on the top rows", () => {
    expect(seek(["❯ iki", "cevap"], 1)).toBe("done");
    expect(seek(["", "❯ iki", "cevap"], 1)).toBe("done");
  });

  it("scrolls down to bring a target lower on the screen to the top", () => {
    expect(seek(["cevap", "x", "❯ iki", "cevap"], 1)).toBe("down");
  });

  it("is done when the target is on screen but the view is already at the bottom", () => {
    expect(seek(["cevap", "x", "❯ dört"], 3, {scrolledUp: false})).toBe("done");
  });

  it("scrolls up while only later prompts are on screen", () => {
    expect(seek(["cevap", "❯ üç"], 1)).toBe("up");
  });

  it("scrolls down while only earlier prompts are on screen", () => {
    expect(seek(["❯ bir", "cevap"], 2)).toBe("down");
  });

  it("is done at the bottom when only earlier prompts are on screen", () => {
    expect(seek(["❯ bir", "cevap"], 2, {scrolledUp: false})).toBe("done");
  });

  it("is done between an earlier and a later prompt, where an unrecognised target must be", () => {
    // the target's echo ("[Pasted text #1]") never matches its transcript text
    expect(seek(["❯ bir", "❯ [Pasted text #1 +17 lines]", "❯ üç"], 1)).toBe("done");
  });

  it("follows the current prompt while no prompt is on screen", () => {
    expect(seek(["uzun", "cevap"], 1, {current: 2})).toBe("up");
    expect(seek(["uzun", "cevap"], 1, {current: 1})).toBe("up"); // its row is above the screen
    expect(seek(["uzun", "cevap"], 2, {current: 1})).toBe("down");
    expect(seek(["uzun", "cevap"], 2, {current: 1, scrolledUp: false})).toBe("done");
  });

  it("ignores the given top rows, like fullscreen Claude Code's sticky header echoing a prompt", () => {
    expect(seek(["❯ iki", "cevap", "❯ üç"], 1, {skipRows: 1})).toBe("up");
  });
});
