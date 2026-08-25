import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDescHtml } from "../src/lib/sanitize.ts";

describe("sanitizeDescHtml (server-side)", () => {
  it("keeps allowed formatting tags", () => {
    assert.equal(sanitizeDescHtml("<p><b>hi</b> <em>there</em></p>"), "<p><b>hi</b> <em>there</em></p>");
  });

  it("unwraps disallowed tags but keeps their text", () => {
    assert.equal(sanitizeDescHtml("<script>alert(1)</script>"), "alert(1)");
    assert.equal(sanitizeDescHtml("<table><tr><td>cell</td></tr></table>"), "cell");
  });

  it("strips event handlers and unknown attributes", () => {
    assert.equal(sanitizeDescHtml('<p onclick="evil()" style="x">hi</p>'), "<p>hi</p>");
    assert.equal(sanitizeDescHtml('<img src="/media/uploads/a.png" onerror="evil()">'), '<img src="/media/uploads/a.png" />');
  });

  it("drops media elements whose src is not an upload path", () => {
    assert.equal(sanitizeDescHtml('<img src="https://evil.com/x.png">'), "");
    assert.equal(sanitizeDescHtml('<img src="data:text/html,x">'), "");
    assert.equal(sanitizeDescHtml('<video src="/etc/passwd"></video>'), "");
  });

  it("keeps http(s) links and forces safe attributes", () => {
    assert.equal(
      sanitizeDescHtml('<a href="https://example.com" onclick="x">link</a>'),
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>'
    );
  });

  it("drops javascript: and relative hrefs", () => {
    assert.equal(sanitizeDescHtml('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
    assert.equal(sanitizeDescHtml('<a href="/relative">x</a>'), "<a>x</a>");
  });

  it("escapes stray angle brackets and drops HTML comments", () => {
    assert.equal(sanitizeDescHtml("5 < 6 and 7 > 3"), "5 &lt; 6 and 7 &gt; 3");
    assert.equal(sanitizeDescHtml("a<!--secret-->b"), "ab");
  });

  it("handles quoted attribute values containing > without breaking", () => {
    assert.equal(sanitizeDescHtml('<a href="https://x.io/?a=1&b=2">q</a>'),
      '<a href="https://x.io/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">q</a>');
  });

  it("escapes text content", () => {
    assert.equal(sanitizeDescHtml('say "hi" & bye'), "say &quot;hi&quot; &amp; bye");
  });

  it("is idempotent on already-sanitized output", () => {
    const once = sanitizeDescHtml('<p><b>x</b></p><img src="/media/uploads/v.webm" />');
    assert.equal(sanitizeDescHtml(once), once);
  });
});
