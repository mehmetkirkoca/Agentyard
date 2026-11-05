import {escapeHtml} from "./html-utils";

describe("escapeHtml", () => {
  it("escapes every character that can open a tag or close an attribute", () => {
    expect(escapeHtml(`<a href="x" id='y'>&`)).toBe("&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;");
  });
});
