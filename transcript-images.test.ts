import {findImageTags, findPastedImage} from "./transcript-images";

const image = (data: string, mediaType = "image/png") => ({type: "image", source: {type: "base64", media_type: mediaType, data}});
const line = (ids: number[], content: unknown[], type = "user") =>
  JSON.stringify({type, imagePasteIds: ids, message: {role: "user", content}});

describe("findImageTags", () => {
  it("finds every label with its position", () => {
    expect(findImageTags("> [Image #1] [Image #12] text")).toEqual([
      {id: 1, start: 2, end: 12},
      {id: 12, start: 13, end: 24},
    ]);
  });

  it("ignores text that only resembles a label", () => {
    expect(findImageTags("[Image #] [Image 1] [Image: source: /a.png] Image #1")).toEqual([]);
  });
});

describe("findPastedImage", () => {
  it("finds an image with its media type", () => {
    const text = line([3], [{type: "text", text: "[Image #3] hi"}, image("AAA", "image/jpeg")]);
    expect(findPastedImage(text, 3)).toEqual({mediaType: "image/jpeg", data: "AAA"});
  });

  it("pairs paste ids with image blocks, wherever the text block is", () => {
    const text = line([3, 4], [image("AAA"), image("BBB"), {type: "text", text: "hi"}]);
    expect(findPastedImage(text, 3)?.data).toBe("AAA");
    expect(findPastedImage(text, 4)?.data).toBe("BBB");
  });

  it("prefers the latest line when an id repeats", () => {
    const text = [line([1], [image("OLD")]), line([1], [image("NEW")])].join("\n");
    expect(findPastedImage(text, 1)?.data).toBe("NEW");
  });

  it("returns null for an unknown id, a broken line or another entry type", () => {
    const text = ['{"imagePasteIds":[1', line([1], [image("AAA")], "assistant"), line([2], [image("BBB")])].join("\n");
    expect(findPastedImage(text, 1)).toBeNull();
  });

  it("rejects a source that is not a base64 image", () => {
    const text = line([1], [{type: "image", source: {type: "base64", media_type: "text/html", data: "AAA"}}]);
    expect(findPastedImage(text, 1)).toBeNull();
  });
});
