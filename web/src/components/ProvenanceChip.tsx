import { shortName } from "../passage.js";
import type { CitedSource, Provenance } from "../types.js";
import "../styles/viewer.css";

const VERDICT: Record<Provenance["fact_check"], { label: string; className: string; title: string } | null> = {
  supported: { label: "fact-checked ✓", className: "ok", title: "A fact check found every claim in this section on the pages it cites" },
  doubted: { label: "check doubted", className: "doubted", title: "A fact check doubted part of this section: read the page" },
  unchecked: null,
};

/**
 * Why a block is on the page, in one chip: the pages it is based on (each opens the original page) and
 * what the fact check said. Personal blocks (stream B) add "made for you" with the reason.
 */
export function ProvenanceChip({
  provenance,
  sources,
  open,
}: {
  provenance: Provenance;
  /** The files the reader may open: pages of other files are listed without a link. */
  sources: ReadonlyMap<string, CitedSource>;
  open: (source: CitedSource, page: number) => void;
}) {
  const verdict = VERDICT[provenance.fact_check];
  // Pages grouped by file: "Lec01 p.3, 4".
  const byFile = new Map<string, number[]>();
  for (const c of provenance.pages) byFile.set(c.source, [...(byFile.get(c.source) ?? []), c.page].filter((p, i, all) => all.indexOf(p) === i));
  return (
    <div className="prov" role="note" aria-label="Where this comes from">
      {provenance.made_for && <span className="prov-made" title={provenance.made_for}>Made for you</span>}
      {[...byFile].map(([id, pages]) => {
        const source = sources.get(id);
        return (
          <span key={id} className="prov-file">
            {source ? shortName(source.name) : id}{" "}
            {pages.map((page, i) =>
              source && page <= source.pages ? (
                <button key={page} className="prov-page" title={`Open ${source.name}, page ${page}`} onClick={() => open(source, page)}>
                  {i === 0 ? "p." : ""}
                  {page}
                </button>
              ) : (
                <span key={page} className="prov-page plain">
                  {i === 0 ? "p." : ""}
                  {page}
                </span>
              ),
            )}
          </span>
        );
      })}
      {verdict && (
        <span className={`prov-check ${verdict.className}`} title={verdict.title}>
          {verdict.label}
        </span>
      )}
    </div>
  );
}
