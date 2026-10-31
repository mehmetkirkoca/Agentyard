/**
 * A fork's transcript ending right before one of the user's prompts, built the way the Claude Code
 * VS Code extension forks a conversation: the message chain (parentUuid links) up to the last user
 * or assistant message before the prompt, every entry under a new uuid and the fork's sessionId.
 * File history (checkpoints for /rewind) is not carried over.
 */

export interface ForkOptions {
  forkUuid: string;
  newUuid: () => string;
  /** ISO timestamp for the last entry, so the fork sorts as just active */
  now: string;
  title: string;
}

const isChainMessage = (e: any) => (e.type === "user" || e.type === "assistant") && !e.isSidechain;

/** Transcript lines (JSONL, no trailing newline) of the fork. Throws when it cannot be built. */
export function buildForkTranscript(entries: any[], promptUuid: string, opts: ForkOptions): string[] {
  const promptAt = entries.findIndex(e => e?.uuid === promptUuid);
  if (promptAt < 0) throw new Error(`Prompt ${promptUuid} not found in the transcript`);
  let resumeAt: any;
  for (let i = promptAt - 1; i >= 0 && !resumeAt; i--) {
    if (entries[i]?.uuid && isChainMessage(entries[i])) resumeAt = entries[i];
  }
  if (!resumeAt) throw new Error("Nothing comes before the first prompt; there is nothing to fork");

  // Walk the parent links up to the root (or a compact boundary, whose parent is null)
  const byUuid = new Map<string, any>();
  for (const e of entries) if (e?.uuid) byUuid.set(e.uuid, e);
  const chain: any[] = [];
  const seen = new Set<string>();
  for (let e = resumeAt; e && !seen.has(e.uuid); e = e.parentUuid ? byUuid.get(e.parentUuid) : undefined) {
    seen.add(e.uuid);
    chain.push(e);
  }
  chain.reverse();

  const ids = new Map<string, string>(chain.map(e => [e.uuid, opts.newUuid()]));
  const kept = chain.filter(e => e.type !== "progress");
  const position = new Map<string, number>(chain.map((e, i) => [e.uuid, i]));

  // Parent in the fork: the nearest earlier chain entry that is kept (progress entries are bridged)
  const forkParent = (e: any): string | null => {
    for (let i = (position.get(e.uuid) ?? 0) - 1; i >= 0; i--) {
      if (chain[i].type !== "progress") return ids.get(chain[i].uuid) ?? null;
    }
    return null;
  };

  const lines = kept.map((e, i) => {
    const out: any = {
      ...e,
      uuid: ids.get(e.uuid),
      parentUuid: e.parentUuid ? forkParent(e) : null,
      sessionId: opts.forkUuid,
      timestamp: i === kept.length - 1 ? opts.now : e.timestamp,
    };
    delete out.sessionKind;
    if (e.type === "system" && e.subtype === "model_refusal_fallback") out.neutralizedByFork = true;
    const source = e.type === "attachment" && e.attachment?.type === "queued_command" ? e.attachment.source_uuid : undefined;
    if (source && ids.has(source)) out.attachment = {...e.attachment, source_uuid: ids.get(source)};
    return JSON.stringify(out);
  });

  const summary = entries.find(e => e?.type === "summary" && e.leafUuid === resumeAt.uuid)?.summary;
  if (summary) lines.push(JSON.stringify({type: "summary", leafUuid: ids.get(resumeAt.uuid), summary}));
  lines.push(JSON.stringify({type: "custom-title", sessionId: opts.forkUuid, customTitle: opts.title}));
  return lines;
}
