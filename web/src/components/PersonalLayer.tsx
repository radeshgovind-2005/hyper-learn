import { marked } from "marked";
import { useCallback, useEffect, useRef, useState } from "react";
import { shortName } from "../passage.js";
import type { Call, Citation, CitedSource, PersonalBlock, Provenance, PublicPiece } from "../types.js";
import { InterventionView } from "./Interventions.js";
import { Storyboard } from "./Storyboard.js";
import "../styles/tutor.css";

// What the tutor made for this learner, under the section it is for, marked "Made for you". It never
// changes the course for anyone else. Rendered with a private PersonalMarkdown until the join swaps in
// stream A's Markdown (KaTeX, figures); the personal writer's Markdown has no images or HTML.

/** Personal block Markdown: the writer's output, already sanitised on the server (no HTML, no images). */
function PersonalMarkdown({ markdown }: { markdown: string }) {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: marked.parse(markdown, { async: false }) as string }} />;
}

/** A generated picture (gen:<id>), fetched once per id and kept for the page's life. */
const pictures = new Map<string, Promise<string>>();
export function GenImage({ call, id, alt }: { call: Call; id: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    if (!pictures.has(id)) pictures.set(id, call<{ mime: string; base64: string }>("generatedImage", [id]).then((p) => `data:${p.mime};base64,${p.base64}`));
    pictures
      .get(id)!
      .then((url) => live && setSrc(url))
      .catch(() => {
        pictures.delete(id);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [call, id]);
  if (failed) return <div className="gen-image missing small muted">{alt}</div>;
  return src ? <img className="gen-image" src={src} alt={alt} /> : <div className="gen-image loading" aria-label="Loading the picture" />;
}

const KIND_LABEL = { rewrite: "Explained for you", diagram: "Diagram", widget: "Try it", storyboard: "Storyboard" } as const;
const APPROACH_LABEL: Record<string, string> = { refute: "untangling the mix-up", worked_example: "a worked example", smaller_steps: "smaller steps" };

function Verdict({ provenance }: { provenance: Provenance }) {
  if (provenance.fact_check === "supported") return <span className="chip green">fact-checked ✓</span>;
  if (provenance.fact_check === "doubted") return <span className="chip amber">a claim was doubted</span>;
  return null;
}

function PageChips({ pages, sources, open }: { pages: readonly Citation[]; sources: ReadonlyMap<string, CitedSource>; open?: ((s: CitedSource, page: number) => void) | undefined }) {
  const chips = pages.flatMap((c) => {
    const source = sources.get(c.source);
    return source ? [{ source, page: c.page }] : [];
  });
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map(({ source, page }) => (
        <button key={`${source.id}:${page}`} className="chip cite" onClick={() => open?.(source, page)} title={`Open ${source.name}, page ${page}`}>
          {shortName(source.name)} · p.{page}
        </button>
      ))}
    </>
  );
}

function PracticeCheck({ call, blockId, piece }: { call: Call; blockId: string; piece: Extract<PublicPiece, { kind: "check" }> }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [result, setResult] = useState<{ correct: boolean; feedback: string } | null>(null);
  return (
    <div className="block check personal-check">
      <div className="check-label small">Practice</div>
      <div className="prompt">{piece.prompt}</div>
      <div className="options" role="radiogroup">
        {piece.options.map((text, i) => (
          <button
            key={i}
            className={`option ${picked === i ? "picked" : ""}`}
            role="radio"
            aria-checked={picked === i}
            onClick={() => {
              setPicked(i);
              void call<{ correct: boolean; feedback: string }>("answerPersonal", [blockId, i]).then(setResult);
            }}
          >
            <span className="mark" aria-hidden />
            <span>{text}</span>
          </button>
        ))}
      </div>
      {result && (
        <div className={`check-feedback ${result.correct ? "right" : "wrong"}`} role="status">
          <strong>{result.correct ? "Right." : "Not quite."}</strong> {result.feedback}
        </div>
      )}
    </div>
  );
}

function Piece({ call, block, piece, sources, open }: { call: Call; block: PersonalBlock; piece: PublicPiece; sources: ReadonlyMap<string, CitedSource>; open?: ((s: CitedSource, page: number) => void) | undefined }) {
  switch (piece.kind) {
    case "text":
      return (
        <>
          <PersonalMarkdown markdown={piece.markdown} />
          {piece.cites.length > 0 && (
            <div className="cites">
              <PageChips pages={piece.cites} sources={sources} open={open} />
            </div>
          )}
        </>
      );
    case "check":
      return <PracticeCheck call={call} blockId={block.id} piece={piece} />;
    case "image":
      return (
        <figure className="gen-figure">
          <GenImage call={call} id={piece.id} alt={piece.caption} />
          <figcaption className="small muted">{piece.caption} · generated by Muse Image</figcaption>
        </figure>
      );
    case "widget":
      return <InterventionView intervention={piece.intervention} />;
    case "storyboard":
      return <Storyboard title={piece.title} frames={piece.frames} image={(id) => <GenImage call={call} id={id} alt="Storyboard frame" />} />;
  }
}

function PersonalCard({ call, block, sources, open, onUndo }: { call: Call; block: PersonalBlock; sources: ReadonlyMap<string, CitedSource>; open?: ((s: CitedSource, page: number) => void) | undefined; onUndo: () => void }) {
  return (
    <div className={`personal ${block.status}`} id={`personal-${block.id}`}>
      <div className="personal-head">
        <span className="chip violet">Made for you</span>
        <span className="personal-kind">
          {KIND_LABEL[block.kind]}
          {block.kind === "rewrite" && block.approach && APPROACH_LABEL[block.approach] ? ` · ${APPROACH_LABEL[block.approach]}` : ""}
        </span>
        <span className="grow" />
        <button className="btn quiet sm" onClick={onUndo} title="Take this down (only you see it)">
          {block.status === "failed" ? "Dismiss" : "Undo"}
        </button>
      </div>
      {block.status === "running" && (
        <div className="personal-running small">
          <span className="spinner" /> Muse is {block.kind === "rewrite" ? "writing this for you from the course's pages and checking it" : block.kind === "diagram" ? "drawing this for you" : "making this for you"}…
        </div>
      )}
      {block.status === "failed" && <div className="personal-failed small">{block.problems[0] ?? "This couldn't be made just now."}</div>}
      {block.status === "ready" && block.pieces.map((piece, i) => <Piece key={i} call={call} block={block} piece={piece} sources={sources} open={open} />)}
      {block.status === "ready" && block.provenance && (
        <div className="provenance small">
          {block.provenance.made_for && <span>Made for you because {block.provenance.made_for}.</span>}
          <span className="provenance-chips">
            <Verdict provenance={block.provenance} />
            {block.provenance.fact_check === "doubted" && block.problems.length > 0 && <span className="muted" title={block.problems.join("\n")}>(why?)</span>}
          </span>
        </div>
      )}
    </div>
  );
}

/** The learner's personal blocks on a lesson, refreshed when the dock says something changed, polled while one is being made. */
export function usePersonalBlocks(call: Call, lessonId: string, version: number, enabled: boolean) {
  const [blocks, setBlocks] = useState<PersonalBlock[]>([]);
  const started = useRef(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    void call<PersonalBlock[]>("personalBlocks", [lessonId])
      .then(setBlocks)
      .catch(() => {});
  }, [call, lessonId, enabled]);
  useEffect(() => {
    started.current = Date.now();
    refresh();
  }, [refresh, version]);
  const running = blocks.some((b) => b.status === "running");
  useEffect(() => {
    // Polling stops when nothing is being made, or after three minutes.
    if (!running || Date.now() - started.current > 180_000) return;
    const timer = setTimeout(refresh, 2_000);
    return () => clearTimeout(timer);
  }, [running, blocks, refresh]);
  return { blocks, refresh };
}

export function PersonalLayer({
  call,
  blocks,
  sources,
  open,
  onChanged,
}: {
  call: Call;
  blocks: readonly PersonalBlock[];
  sources: ReadonlyMap<string, CitedSource>;
  open?: (s: CitedSource, page: number) => void;
  onChanged: () => void;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="personal-layer">
      {blocks.map((block) => (
        <PersonalCard
          key={block.id}
          call={call}
          block={block}
          sources={sources}
          open={open}
          onUndo={() => {
            void call("undoPersonal", [block.id]).finally(onChanged);
          }}
        />
      ))}
    </div>
  );
}
