import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import { extractMath, mathToken, repairLists, segments, withMath } from "./markdown.js";

describe("repairLists", () => {
  it("starts a new paragraph after a list (the live Lesson 1 text)", () => {
    const fused = "- Simulation and modelling\n- Big data, crypto, AI\nSequential programming by itself is not enough anymore.";
    assert.equal(repairLists(fused), "- Simulation and modelling\n- Big data, crypto, AI\n\nSequential programming by itself is not enough anymore.");
  });

  it("keeps indented continuations, numbered lists, fences and plain paragraphs as they are", () => {
    for (const text of ["- one\n  still one\n- two", "1. first\n2. second", "Just a paragraph\nwrapped here.", "```\n- a\nnot a paragraph\n```", "- a\n\nAfter a blank line."]) {
      assert.equal(repairLists(text), text);
    }
  });
});

describe("extractMath", () => {
  it("takes out inline and display formulas", () => {
    const { text, math } = extractMath("Power $P \\propto C V^2 f$ grows.\n\n$$S(N) = \\frac{1}{(1-p) + p/N}$$");
    assert.equal(text, `Power ${mathToken(0)} grows.\n\n${mathToken(1)}`);
    assert.deepEqual(math, [
      { tex: "P \\propto C V^2 f", display: false },
      { tex: "S(N) = \\frac{1}{(1-p) + p/N}", display: true },
    ]);
  });

  it("keeps < and _ inside a formula away from Markdown", () => {
    const { text, math } = extractMath("If $a_i < b_j$ then");
    assert.equal(text, `If ${mathToken(0)} then`);
    assert.equal(math[0]!.tex, "a_i < b_j");
  });

  it("leaves prices, code and escaped dollars alone", () => {
    for (const text of ["It costs $5 and $10.", "Run `echo $HOME $PATH` now", "```\nx = $a$\n```", "A \\$ sign and $ alone"]) {
      assert.deepEqual(extractMath(text), { text, math: [] });
    }
  });
});

describe("segments", () => {
  const html = (markdown: string) => segments(markdown).segments.map((s) => ("html" in s ? s.html : `[${s.asset.kind}:${s.asset.id}]`)).join("");

  it("renders a Markdown table as a table", () => {
    const out = html("| Level | Latency |\n|---|---|\n| L1 | <1 ns |\n| DRAM | ~100 ns |");
    assert.match(out, /<table>[\s\S]*<th>Level<\/th>[\s\S]*<td>DRAM<\/td>/);
    assert.match(out, /&lt;1 ns/);
  });

  it("renders a formula with KaTeX, and as code before KaTeX loads", () => {
    const { segments: parts, math } = segments("Power $P \\propto C \\times V^2 \\times f$ grows.");
    const part = parts[0] as { html: string };
    assert.match(withMath(part.html, math, katex), /class="katex"/);
    assert.match(withMath(part.html, math, null), /<code class="math-pending">P \\propto/);
  });

  it("draws a fig: or gen: picture on its own line, and shows the alt text of one inside a sentence", () => {
    assert.deepEqual(segments("![The levels](fig:s1/p15/f1)").segments, [{ asset: { kind: "fig", id: "s1/p15/f1", alt: "The levels" } }]);
    assert.equal(html("Before\n\n![Made for you](gen:3fa9c1d2)\n\nAfter"), "<p>Before</p>\n[gen:3fa9c1d2]<p>After</p>\n");
    assert.equal(html("See ![the chart](fig:s1/p7/f1) here"), "<p>See <em>the chart</em> here</p>\n");
    assert.equal(html("![x](https://evil.example/x.png)"), "<p><em>x</em></p>\n");
  });

  it("shows raw HTML as text", () => {
    assert.equal(html("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
    assert.match(html("a <img src=x onerror=alert(1)> b"), /a &lt;img src=x onerror=alert\(1\)&gt; b/);
  });

  it("splits a list from the paragraph after it", () => {
    assert.match(html("- Big data, crypto, AI\nSequential programming"), /<\/ul>\n<p>Sequential programming<\/p>/);
  });
});
