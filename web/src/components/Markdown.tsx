import { type ReactNode, useEffect, useMemo, useState } from "react";
import { escapeHtml, extractMath, type Katex, segments, withMath } from "../markdown.js";
import type { Call } from "../types.js";
import { AssetImage } from "./AssetImage.js";

// Lesson Markdown as the reader sees it: Markdown (with tables), formulas by KaTeX, and `fig:` / `gen:`
// pictures through AssetImage. Raw HTML is shown as text, never as HTML: generated text is sanitised on
// the server too, but this component is shared with personal blocks, so it doesn't trust its input.

let katexLoad: Promise<Katex> | undefined;
/** KaTeX and its stylesheet load on the first formula, not with the app. */
function loadKatex(): Promise<Katex> {
  katexLoad ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([k]) => k.default);
  return katexLoad;
}

function useKatex(needed: boolean): Katex | null {
  const [katex, setKatex] = useState<Katex | null>(null);
  useEffect(() => {
    if (!needed || katex) return;
    let current = true;
    void loadKatex().then((k) => current && setKatex(() => k));
    return () => {
      current = false;
    };
  }, [needed, katex]);
  return katex;
}

/**
 * One block of lesson Markdown. `call` fetches `fig:`/`gen:` pictures; without it they show their alt text.
 * Stream B renders personal blocks with it too (JOIN.md §2).
 */
export function Markdown({ markdown, call, className }: { markdown: string; call?: Call | undefined; className?: string }): ReactNode {
  const parsed = useMemo(() => segments(markdown), [markdown]);
  const katex = useKatex(parsed.math.length > 0);
  return (
    <div className={className}>
      {parsed.segments.map((segment, i) =>
        "html" in segment ? (
          <div key={i} className="md-part" dangerouslySetInnerHTML={{ __html: withMath(segment.html, parsed.math, katex) }} />
        ) : (
          <AssetImage key={i} call={call} kind={segment.asset.kind} id={segment.asset.id} alt={segment.asset.alt} />
        ),
      )}
    </div>
  );
}

/** Plain text (a quiz prompt or option) with its `$…$` formulas drawn by KaTeX. No Markdown and no HTML: the rest stays text. */
export function MathText({ text }: { text: string }): ReactNode {
  const { text: plain, math } = extractMath(text);
  const katex = useKatex(math.length > 0);
  if (math.length === 0) return <>{text}</>;
  return <span dangerouslySetInnerHTML={{ __html: withMath(escapeHtml(plain), math, katex) }} />;
}
