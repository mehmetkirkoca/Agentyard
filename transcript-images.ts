export interface PastedImage {
  mediaType: string;
  data: string;
}

export interface ImageTag {
  id: number;
  start: number;
  end: number; // exclusive
}

/** The [Image #N] labels Claude Code shows for pasted images. */
export function findImageTags(text: string): ImageTag[] {
  return [...text.matchAll(/\[Image #(\d+)\]/g)].map(match => ({
    id: Number(match[1]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * The image a transcript stores for [Image #id]. A user line lists its paste ids in imagePasteIds,
 * in the order of its image blocks. Ids can repeat after a resume, so the latest line wins.
 */
export function findPastedImage(transcript: string, id: number): PastedImage | null {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"imagePasteIds"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type !== "user" || !Array.isArray(entry.imagePasteIds)) continue;
    const index = entry.imagePasteIds.indexOf(id);
    if (index < 0 || !Array.isArray(entry.message?.content)) continue;
    const source = entry.message.content.filter((block: any) => block?.type === "image")[index]?.source;
    if (source?.type === "base64" && /^image\/[a-z+.-]+$/.test(source.media_type) && typeof source.data === "string") {
      return {mediaType: source.media_type, data: source.data};
    }
  }
  return null;
}
