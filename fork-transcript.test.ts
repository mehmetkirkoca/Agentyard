import {buildForkTranscript} from "./fork-transcript";

const SRC = "11111111-1111-4111-8111-111111111111";
const FORK = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-31T12:00:00.000Z";

const msg = (type: string, uuid: string, parentUuid: string | null, extra: object = {}) =>
  ({type, uuid, parentUuid, sessionId: SRC, session_id: SRC, timestamp: `t-${uuid}`, ...extra});

// first turn (u1 → a1 → s1), then the forked prompt u2 with its answer
const entries = [
  {type: "mode", mode: "normal", sessionId: SRC},
  msg("user", "u1", null, {message: {role: "user", content: "ilk soru"}}),
  {type: "api-request", sessionId: SRC},
  msg("progress", "p1", "u1"),
  msg("assistant", "a1", "p1", {message: {content: [{type: "text", text: "cevap"}]}}),
  msg("system", "s1", "a1", {subtype: "turn_duration"}),
  {type: "file-history-snapshot", messageId: "u2", snapshot: {}},
  msg("user", "u2", "s1", {message: {role: "user", content: "ikinci soru"}}),
  msg("assistant", "a2", "u2"),
];

let counter = 0;
const newUuid = () => `new-${++counter}`;
const parse = (lines: string[]) => lines.map(line => JSON.parse(line));

beforeEach(() => {
  counter = 0;
});

describe("buildForkTranscript", () => {
  it("keeps the chain up to the last message before the prompt, with new ids", () => {
    const out = parse(buildForkTranscript(entries, "u2", {forkUuid: FORK, newUuid, now: NOW, title: "Ad (fork)"}));
    expect(out.map(e => e.type)).toEqual(["user", "assistant", "custom-title"]);
    const [user, assistant, title] = out;
    expect(user.parentUuid).toBeNull();
    expect(assistant.parentUuid).toBe(user.uuid); // the skipped progress entry is bridged
    expect(new Set([user.uuid, assistant.uuid]).size).toBe(2);
    expect([user.uuid, assistant.uuid].every(id => id.startsWith("new-"))).toBe(true);
    expect(user.message.content).toBe("ilk soru");
    expect(title).toEqual({type: "custom-title", sessionId: FORK, customTitle: "Ad (fork)"});
  });

  it("moves the entries to the fork session and stamps the last one now", () => {
    const out = parse(buildForkTranscript(entries, "u2", {forkUuid: FORK, newUuid, now: NOW, title: "x"}));
    expect(out.slice(0, 2).every(e => e.sessionId === FORK)).toBe(true);
    expect(out[0].timestamp).toBe("t-u1");
    expect(out[1].timestamp).toBe(NOW);
  });

  it("ends on the last user or assistant message, leaving later system entries out", () => {
    const out = parse(buildForkTranscript(entries, "u2", {forkUuid: FORK, newUuid, now: NOW, title: "x"}));
    expect(out.some(e => e.subtype === "turn_duration")).toBe(false);
  });

  it("leaves out entries off the chain, like messages of an abandoned branch", () => {
    const branched = [
      ...entries.slice(0, 5),
      msg("user", "old", "a1", {message: {content: "vazgeçilen"}}),
      msg("assistant", "a1b", "u1"),
      msg("user", "u3", "a1b", {message: {content: "soru"}}),
    ];
    const out = parse(buildForkTranscript(branched, "u3", {forkUuid: FORK, newUuid, now: NOW, title: "x"}));
    expect(out.filter(e => e.type !== "custom-title").map(e => e.message?.content ?? e.type)).toEqual(["ilk soru", "assistant"]);
  });

  it("drops the session kind, neutralises refusal fallbacks and remaps queued commands", () => {
    const special = [
      msg("user", "u1", null, {sessionKind: "bg", message: {content: "soru"}}),
      msg("system", "s1", "u1", {subtype: "model_refusal_fallback"}),
      msg("attachment", "q1", "s1", {attachment: {type: "queued_command", source_uuid: "u1"}}),
      msg("assistant", "a1", "q1"),
      msg("user", "u2", "a1", {message: {content: "sonraki"}}),
    ];
    const out = parse(buildForkTranscript(special, "u2", {forkUuid: FORK, newUuid, now: NOW, title: "x"}));
    expect(out[0].sessionKind).toBeUndefined();
    expect(out[1].neutralizedByFork).toBe(true);
    expect(out[2].attachment.source_uuid).toBe(out[0].uuid);
  });

  it("carries the summary of the kept leaf", () => {
    const withSummary = [...entries, {type: "summary", leafUuid: "a1", summary: "Özet"}];
    const out = parse(buildForkTranscript(withSummary, "u2", {forkUuid: FORK, newUuid, now: NOW, title: "x"}));
    expect(out[2]).toEqual({type: "summary", leafUuid: out[1].uuid, summary: "Özet"});
  });

  it("refuses a missing prompt or one with nothing before it", () => {
    expect(() => buildForkTranscript(entries, "yok", {forkUuid: FORK, newUuid, now: NOW, title: "x"})).toThrow(/not found/);
    expect(() => buildForkTranscript(entries, "u1", {forkUuid: FORK, newUuid, now: NOW, title: "x"})).toThrow(/first prompt/);
  });
});
