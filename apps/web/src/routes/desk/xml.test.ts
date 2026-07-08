import { describe, expect, it } from "vitest";
import { el, escapeXml, serializeXml, val } from "./xml";

describe("escapeXml", () => {
  it("escapes exactly the five XML-significant characters", () => {
    expect(escapeXml(`Alto & "Friends" <3, y'all >`)).toBe(
      "Alto &amp; &quot;Friends&quot; &lt;3, y&apos;all &gt;",
    );
  });

  it("passes everything else through untouched (unicode included)", () => {
    expect(escapeXml("María — Sopran № 2 🎶")).toBe("María — Sopran № 2 🎶");
  });

  it("escapes an already-escaped string again (no double-unescape trap)", () => {
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });
});

describe("el / val", () => {
  it("rejects invalid tag and attribute names (injection-proof tags)", () => {
    expect(() => el("Bad Tag")).toThrow(/invalid tag/);
    expect(() => el("Ok", { "bad attr": 1 })).toThrow(/invalid attribute/);
    expect(() => el('a"><evil')).toThrow(/invalid tag/);
  });

  it("val wraps scalars in the Live Value idiom", () => {
    expect(serializeXml(val("Tempo", 120))).toContain('<Tempo Value="120" />');
    expect(serializeXml(val("IsWarped", false))).toContain('<IsWarped Value="false" />');
    expect(serializeXml(val("Name", "A&B"))).toContain('<Name Value="A&amp;B" />');
  });
});

describe("serializeXml", () => {
  it("writes declaration, tab indentation, and Live-style self-closing", () => {
    const doc = serializeXml(
      el("Root", { Id: 1 }, [el("Child", {}, [val("Leaf", "x")]), val("Empty", 0)]),
    );
    expect(doc).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<Root Id="1">\n` +
        `\t<Child>\n` +
        `\t\t<Leaf Value="x" />\n` +
        `\t</Child>\n` +
        `\t<Empty Value="0" />\n` +
        `</Root>\n`,
    );
  });

  it("escapes attribute values on the way out, not the way in", () => {
    const doc = serializeXml(el("T", { Name: `<i>&"'` }));
    expect(doc).toContain(`<T Name="&lt;i&gt;&amp;&quot;&apos;" />`);
  });

  it("refuses non-finite and exponent-notation numbers", () => {
    expect(() => serializeXml(val("V", Number.NaN))).toThrow(/non-finite/);
    expect(() => serializeXml(val("V", Number.POSITIVE_INFINITY))).toThrow(/non-finite/);
    expect(() => serializeXml(val("V", 1e-9))).toThrow(/exponent/);
  });
});
