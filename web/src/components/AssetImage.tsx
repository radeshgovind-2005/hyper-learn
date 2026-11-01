import { useEffect, useState } from "react";
import type { Call, Figure, PageImage } from "../types.js";
import "../styles/viewer.css";

// Pictures inside lesson Markdown: `fig:` (a figure on a source page, cropped by its box) and `gen:` (an
// image made for one learner, stream B's generatedImage). If anything fails, the alt text is shown.

/** Fetches are shared per page load: a figure and its page are asked for once, however often they appear. */
const cache = new Map<string, Promise<unknown>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = load();
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

const dataUrl = (image: { mime: string; base64: string }) => `data:${image.mime};base64,${image.base64}`;

interface Loaded {
  src: string;
  figure?: Figure;
  /** The page image's own width / height, to size the crop's frame. */
  aspect?: number;
}

async function loadFigure(call: Call, id: string): Promise<Loaded> {
  const figure = await once(`figure:${id}`, () => call<Figure>("figure", [id]));
  const page = await once(`page:${figure.source}:${figure.page}`, () => call<PageImage | null>("pageImage", [figure.source, figure.page]));
  if (!page) throw new Error("No picture of this page");
  const src = dataUrl(page);
  const aspect = await once(`aspect:${figure.source}:${figure.page}`, () =>
    new Promise<number>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth / Math.max(1, img.naturalHeight));
      img.onerror = () => reject(new Error("The page image didn't load"));
      img.src = src;
    }),
  );
  return { src, figure, aspect };
}

async function loadGenerated(call: Call, id: string): Promise<Loaded> {
  const image = await once(`gen:${id}`, () => call<{ mime: string; base64: string } | { url: string }>("generatedImage", [id]));
  return { src: "url" in image ? image.url : dataUrl(image) };
}

export function AssetImage({ call, kind, id, alt }: { call: Call | undefined; kind: "fig" | "gen"; id: string; alt: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(!call);

  useEffect(() => {
    if (!call) return;
    let current = true;
    (kind === "fig" ? loadFigure(call, id) : loadGenerated(call, id))
      .then((l) => current && setLoaded(l))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [call, kind, id]);

  if (failed) return <span className="asset-alt">{alt}</span>;
  if (!loaded) return <span className="asset-loading small muted">Loading the picture…</span>;
  const caption = alt || loaded.figure?.caption || "";
  const box = loaded.figure?.box;
  if (!box || !loaded.aspect) {
    return (
      <figure className="asset">
        <img src={loaded.src} alt={caption} />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    );
  }
  // The crop: the page image scaled so the box fills a frame of the box's own shape.
  const w = Math.max(0.01, box.x2 - box.x1);
  const h = Math.max(0.01, box.y2 - box.y1);
  return (
    <figure className="asset">
      <div className="asset-crop" style={{ aspectRatio: `${w * loaded.aspect} / ${h}` }} role="img" aria-label={caption}>
        <img src={loaded.src} alt="" style={{ width: `${100 / w}%`, height: `${100 / h}%`, left: `${(-box.x1 / w) * 100}%`, top: `${(-box.y1 / h) * 100}%` }} />
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
