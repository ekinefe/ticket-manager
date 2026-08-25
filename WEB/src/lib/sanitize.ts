/**
 * Server-side allowlist sanitizer for rich-text ticket descriptions.
 *
 * The client applies the same policy before display, but the server must not
 * trust that: descriptions arrive through the public API and are stored
 * verbatim, so sanitization happens here before persistence.
 *
 * Policy (mirrors client/js/ui.js sanitizeDesc):
 *  - only formatting/structural tags survive; everything else is unwrapped
 *    (its text content is kept, the tag itself is dropped)
 *  - attributes are stripped everywhere except:
 *      A.href  -> only http(s), forced to target=_blank + rel=noopener
 *      IMG/VIDEO src -> only /media/uploads/* paths, plus alt/controls/playsinline
 *  - IMG/VIDEO with an invalid src are dropped entirely
 *  - comments and stray "<" text are neutralized
 */

const ALLOWED_TAGS = new Set([
  "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL",
  "UL", "OL", "LI", "BR", "P", "DIV", "H2", "H3",
  "CODE", "PRE", "BLOCKQUOTE", "A", "SPAN", "IMG", "VIDEO",
]);
const VOID_TAGS = new Set(["BR", "IMG"]);
const MEDIA_TAGS = new Set(["IMG", "VIDEO"]);
const MEDIA_ATTRS = new Set(["src", "alt", "controls", "playsinline"]);

function escText(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escAttr(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Full tag token: opening or closing, quoted attribute values allowed.
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^"'>])*)(\/?)>/;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function rebuildAttrs(tag: string, attrText: string): string | null {
  const attrs: string[] = [];
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrText)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (tag === "A" && name === "href") {
      if (/^https?:\/\//i.test(value)) {
        attrs.push(`href="${escAttr(value)}" target="_blank" rel="noopener noreferrer"`);
      }
    } else if (MEDIA_TAGS.has(tag) && MEDIA_ATTRS.has(name)) {
      if (name === "src" && !value.startsWith("/media/uploads/")) {
        return null; // drop the whole media element on an invalid src
      }
      attrs.push(`${name}="${escAttr(value)}"`);
    }
    // every other attribute is stripped
  }
  return attrs.length ? " " + attrs.join(" ") : "";
}

export function sanitizeDescHtml(html: string): string {
  const src = String(html ?? "");
  let out = "";
  let i = 0;
  // When a media element is dropped (invalid src), everything up to and
  // including its closing tag is dropped as well (mirrors client el.remove()).
  let dropClose: string | null = null;
  while (i < src.length) {
    if (dropClose) {
      const closeIdx = src.toLowerCase().indexOf(`</${dropClose.toLowerCase()}>`, i);
      i = closeIdx === -1 ? src.length : closeIdx + dropClose.length + 3;
      dropClose = null;
      continue;
    }
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out += escText(src.slice(i));
      break;
    }
    out += escText(src.slice(i, lt));

    // Comments are dropped entirely.
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }

    const m = TAG_RE.exec(src.slice(lt));
    if (!m) {
      // Stray "<" that does not open a well-formed tag: escape it.
      out += "&lt;";
      i = lt + 1;
      continue;
    }

    const [, close, nameRaw, attrText = "", selfClose] = m;
    const tag = nameRaw.toUpperCase();
    const lower = nameRaw.toLowerCase();
    i = lt + m[0].length;

    if (!ALLOWED_TAGS.has(tag)) continue; // unwrap: keep children, drop tag
    if (close) {
      if (!VOID_TAGS.has(tag)) out += `</${lower}>`;
      continue;
    }
    const attrs = rebuildAttrs(tag, attrText);
    if (attrs === null) {
      if (MEDIA_TAGS.has(tag) && !close) dropClose = tag;
      continue;
    }
    if (VOID_TAGS.has(tag)) {
      out += `<${lower}${attrs} />`;
      continue;
    }
    out += selfClose ? `<${lower}${attrs}></${lower}>` : `<${lower}${attrs}>`;
  }
  return out;
}
