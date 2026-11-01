import { marked, type Token, type Tokens } from "marked";

// Pure helpers behind the Markdown component (components/Markdown.tsx): lesson Markdown in, HTML parts
// and pictures out. Kept apart from React so they can be tested on Node.

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s/;

/**
 * A line of prose straight after a list belongs to a new paragraph, not to the last item. Markdown reads
 * it as the item's continuation ("…crypto, AI Sequential programming…"), which is how lists from PDF
 * text and older builds rendered fused. Indented lines still continue the item.
 */
export function repairLists(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  let inList = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      inList = false;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (line.trim() === "") inList = false;
    else if (LIST_ITEM.test(line)) inList = true;
    else if (inList && !/^\s/.test(line)) {
      out.push("");
      inList = false;
    }
    out.push(line);
  }
  return out.join("\n");
}

export interface MathSpan {
  tex: string;
  display: boolean;
}

/** Stands in for a formula while `marked` runs: letters only, so no Markdown rule touches it. */
export const mathToken = (i: number) => `KATEXMATH${i}KATEXEND`;
export const MATH_TOKEN = /KATEXMATH(\d+)KATEXEND/g;

/**
 * `$$…$$` (display) and `$…$` (inline) formulas, taken out before Markdown is parsed so `_`, `*` and `<`
 * inside them reach KaTeX untouched. Code spans and fences are left alone. An inline `$` must hug its
 * formula (`$x$`, not `$ 5 and $`) and the closing one can't be followed by a digit, so prices aren't maths.
 */
export function extractMath(markdown: string): { text: string; math: MathSpan[] } {
  const math: MathSpan[] = [];
  const take = (tex: string, display: boolean) => {
    math.push({ tex: tex.trim(), display });
    return mathToken(math.length - 1);
  };
  const outside = (text: string) =>
    text.replace(/\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?=[^\s$])([^$\n]*?[^\s\\])\$(?!\d)/g, (_, display: string | undefined, inline: string | undefined) =>
      display !== undefined ? take(display, true) : take(inline!, false),
    );
  // Fences and inline code split the text; only the parts outside them are searched.
  const parts = markdown.split(/(^\s*```[\s\S]*?^\s*```\s*$|`[^`\n]*`)/m);
  const text = parts.map((part, i) => (i % 2 === 1 ? part : outside(part))).join("");
  return { text, math };
}

export type Katex = typeof import("katex").default;

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Same rule as ASSET_REF in src/media/contracts.ts (the UI imports no code from the core). */
const ASSET = /^(fig|gen):([a-z0-9][a-z0-9/_-]{0,79})$/;

const renderer = new marked.Renderer();
// Raw HTML is shown as text: generated text is sanitised on the server too, but personal blocks share this.
renderer.html = ({ text }) => escape(text);
// A picture inside running text shows its alt text; one on its own line is drawn (see segments).
renderer.image = ({ text }) => `<em>${escape(text)}</em>`;

export interface Asset {
  kind: "fig" | "gen";
  id: string;
  alt: string;
}

/** A paragraph that is just one `fig:`/`gen:` picture. */
function assetOf(token: Token): Asset | null {
  if (token.type !== "paragraph") return null;
  const inner = (token as Tokens.Paragraph).tokens.filter((t) => !(t.type === "text" && !t.raw.trim()));
  const image = inner.length === 1 && inner[0]!.type === "image" ? (inner[0] as Tokens.Image) : null;
  const match = image && ASSET.exec(image.href);
  return match ? { kind: match[1] as Asset["kind"], id: match[2]!, alt: image.text } : null;
}

export type Segment = { html: string } | { asset: Asset };

/** Lesson Markdown as HTML parts (with formula placeholders) and the pictures between them. */
export function segments(markdown: string): { segments: Segment[]; math: MathSpan[] } {
  const { text, math } = extractMath(repairLists(markdown));
  const tokens = marked.lexer(text);
  const out: Segment[] = [];
  let run: Token[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push({ html: marked.parser(Object.assign(run, { links: tokens.links }), { renderer }) });
    run = [];
  };
  for (const token of tokens) {
    const asset = assetOf(token);
    if (asset) {
      flush();
      out.push({ asset });
    } else run.push(token);
  }
  flush();
  return { segments: out, math };
}

/** Puts the formulas back: KaTeX's HTML once it has loaded, the TeX as code until then. */
export function withMath(html: string, math: readonly MathSpan[], katex: Katex | null): string {
  return html.replace(MATH_TOKEN, (_, n: string) => {
    const span = math[Number(n)];
    if (!span) return "";
    if (!katex) return `<code class="math-pending">${escape(span.tex)}</code>`;
    return katex.renderToString(span.tex, { displayMode: span.display, throwOnError: false, trust: false, strict: "ignore", output: "htmlAndMathml" });
  });
}
