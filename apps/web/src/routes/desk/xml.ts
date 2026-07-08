// Dependency-free XML writer (W3-B): a tiny element tree + serializer for
// the Ableton .als export. Deliberately a builder rather than string
// concatenation at call sites — every attribute value passes through ONE
// escaping function, so a lane named `Alto & "Friends" <3` can never
// corrupt the document. Output cosmetics follow what Live itself emits
// (tab indentation, `<Tag Value="x" />` self-closing with a space) so a
// generated set diffs cleanly against a real one when debugging.

export interface XmlElement {
  tag: string;
  attrs: Array<[name: string, value: string | number]>;
  children: XmlElement[];
}

// XML 1.0 Name, ASCII subset — all we ever emit. A bad tag is a programmer
// error, and catching it here keeps the serializer injection-proof by
// construction (tags/attr names are validated, attr values are escaped).
const NAME_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** Build an element. Attribute values may be strings or finite numbers;
 * children are nested elements (text nodes never occur in the .als subset
 * we write — Live keeps all scalar state in `Value` attributes). */
export function el(
  tag: string,
  attrs: Record<string, string | number> = {},
  children: XmlElement[] = [],
): XmlElement {
  if (!NAME_RE.test(tag)) throw new Error(`xml: invalid tag name ${JSON.stringify(tag)}`);
  const pairs: Array<[string, string | number]> = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (!NAME_RE.test(name)) throw new Error(`xml: invalid attribute name ${JSON.stringify(name)}`);
    pairs.push([name, value]);
  }
  return { tag, attrs: pairs, children };
}

/** `<Tag Value="…" />` — the idiom Live's schema uses for every scalar. */
export function val(tag: string, value: string | number | boolean): XmlElement {
  return el(tag, { Value: typeof value === "boolean" ? String(value) : value });
}

/** Escape a string for use in an attribute value (double-quoted) or text.
 * The five XML-significant characters, exactly once each — values reach
 * the serializer raw and are escaped in one place only. */
export function escapeXml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Numbers must serialize the way Live's parser reads them: plain decimal,
 * never exponent notation, never NaN/Infinity. Values in this document are
 * seconds/beats/linear-gains — well inside the range where JS `toString`
 * stays plain — but the guard makes that a checked invariant. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`xml: non-finite number ${n}`);
  const s = String(n);
  if (s.includes("e") || s.includes("E")) throw new Error(`xml: exponent notation ${s}`);
  return s;
}

function formatAttr(value: string | number): string {
  return typeof value === "number" ? formatNumber(value) : escapeXml(value);
}

/** Serialize a document: XML declaration + the element tree, tab-indented,
 * LF line endings (what Live writes). */
export function serializeXml(root: XmlElement): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  serializeInto(root, 0, lines);
  return `${lines.join("\n")}\n`;
}

function serializeInto(node: XmlElement, depth: number, lines: string[]): void {
  const indent = "\t".repeat(depth);
  const attrs = node.attrs.map(([name, value]) => ` ${name}="${formatAttr(value)}"`).join("");
  if (node.children.length === 0) {
    lines.push(`${indent}<${node.tag}${attrs} />`);
    return;
  }
  lines.push(`${indent}<${node.tag}${attrs}>`);
  for (const child of node.children) serializeInto(child, depth + 1, lines);
  lines.push(`${indent}</${node.tag}>`);
}
