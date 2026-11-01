import {agyEffortsFor, agyModelCommand, AGY_FALLBACK_MODELS, groupAgyModels, parseAgyFooter} from "./antigravity-screen";

// Footer rows as agy 1.4.12 draws them: hints on the left, "[mode · ]Model · effort" on the right
describe("parseAgyFooter", () => {
  it("reads mode, model and effort from the footer", () => {
    expect(parseAgyFooter(["────", ">", "────", "? for shortcuts            accept-edits · Gemini 4 Argon · medium"]))
      .toEqual({mode: "accept-edits", model: "Gemini 4 Argon", effort: "medium"});
  });

  it("is the default mode when the footer names none", () => {
    expect(parseAgyFooter(["? for shortcuts      Claude Sonnet 5.5 · low"]))
      .toEqual({mode: "default", model: "Claude Sonnet 5.5", effort: "low"});
  });

  it("reads the footer while a prompt or menu replaces the hints", () => {
    expect(parseAgyFooter(["esc to cancel        plan · Gemini 4 Argon · high"])?.mode).toBe("plan");
    // while agy works the hint is "esc to cancel" (seen in Agentyard, agy 1.4.12)
    expect(parseAgyFooter(["esc to cancel                                  Gemini 3.8 Flash · low"]))
      .toEqual({mode: "default", model: "Gemini 3.8 Flash", effort: "low"});
    expect(parseAgyFooter(["                     GPT-OSS 120B · medium"])?.model).toBe("GPT-OSS 120B");
  });

  it("uses the lowest footer line", () => {
    expect(parseAgyFooter(["? for shortcuts   plan · Gemini 4 Argon · high", "? for shortcuts   Gemini 4 Argon · low"])?.mode)
      .toBe("default");
  });

  it("is undefined without a footer", () => {
    expect(parseAgyFooter(["> type here", ""])).toBeUndefined();
    expect(parseAgyFooter(["> explain a · b · low"])).toBeUndefined();
  });
});

describe("groupAgyModels", () => {
  it("groups `agy models` output into families", () => {
    const out = "Fetching available models...\n"
      + "gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\n"
      + "gemini-4-argon-low\tGemini 4 Argon (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
    expect(groupAgyModels(out)).toEqual([
      {base: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"]},
      {base: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"]},
    ]);
  });

  it("is empty for output without models", () => {
    expect(groupAgyModels("Error: not logged in\n")).toEqual([]);
  });
});

describe("agyModelCommand", () => {
  it("keeps the current effort when the family has it", () => {
    expect(agyModelCommand({base: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"]}, "high"))
      .toBe("/model claude-sonnet-5-5-high");
  });

  it("falls back to the family's only effort", () => {
    expect(agyModelCommand({base: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"]}, "high"))
      .toBe("/model gpt-oss-120b-medium");
  });

  it("uses agy's real ids in the fallback", () => {
    // `agy models` 1.4.12: gemini-3.8-flash-high, claude-opus-5-5-low, gpt-oss-120b-medium …
    expect(AGY_FALLBACK_MODELS.map(m => m.base))
      .toEqual(["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"]);
  });

  it("has the five families of agy 1.4.12 as fallback", () => {
    expect(AGY_FALLBACK_MODELS.map(m => m.label))
      .toEqual(["Gemini 4 Argon", "Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"]);
  });
});

describe("agyEffortsFor", () => {
  it("offers only the efforts the current model has", () => {
    expect(agyEffortsFor(AGY_FALLBACK_MODELS, "GPT-OSS 120B")).toEqual(["medium"]);
    expect(agyEffortsFor(AGY_FALLBACK_MODELS, "Claude Sonnet 5.5")).toEqual(["low", "medium", "high"]);
  });

  it("offers all efforts for an unknown or unread model", () => {
    expect(agyEffortsFor(AGY_FALLBACK_MODELS, undefined)).toEqual(["low", "medium", "high"]);
    expect(agyEffortsFor(AGY_FALLBACK_MODELS, "Gemini 9")).toEqual(["low", "medium", "high"]);
  });
});
