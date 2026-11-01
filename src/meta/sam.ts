import type { PageImage } from "../media/contracts.js";
import type { Box } from "../storage/media.js";
import { type MetaClientConfig, metaFetch } from "./client.js";

// SAM 3.1 finds an object on an image from a short text prompt, through the Responses API. It answers in
// special-token text, one `<|box;x1=…;y1=…;x2=…;y2=…;w=…;h=…|>` (and a mask we don't use) per match
// (docs/hackathon/spike-A.md, S3). It needs a concrete noun ("chart"), not a layout word ("figure").

const BOX = /<\|box;x1=(-?[\d.]+);y1=(-?[\d.]+);x2=(-?[\d.]+);y2=(-?[\d.]+);w=([\d.]+);h=([\d.]+)\|>/g;

/** Boxes in SAM's output text, as fractions of the image. Malformed ones are skipped. */
export function parseBoxes(text: string): Box[] {
  const boxes: Box[] = [];
  for (const m of text.matchAll(BOX)) {
    const [x1, y1, x2, y2, w, h] = m.slice(1).map(Number) as [number, number, number, number, number, number];
    if (!(w > 0 && h > 0 && x2 > x1 && y2 > y1)) continue;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    boxes.push({ x1: clamp(x1 / w), y1: clamp(y1 / h), x2: clamp(x2 / w), y2: clamp(y2 / h) });
  }
  return boxes;
}

/** The boxes SAM finds for `prompt` on the image. Throws on an HTTP error. */
export async function segment(config: MetaClientConfig, image: PageImage, prompt: string): Promise<Box[]> {
  const res = await metaFetch(config, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "sam-3.1",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: prompt.slice(0, 60) },
            { type: "input_image", image_url: `data:${image.mime};base64,${image.base64}` },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Segmentation call failed: HTTP ${res.status}`);
  const body = (await res.json()) as { output?: { content?: { text?: string }[] }[] };
  const text = (body.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("\n");
  return parseBoxes(text);
}
