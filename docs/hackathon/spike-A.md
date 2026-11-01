# Spike A1: can Meta read our pages?

Run 2026-11-01 with `scripts/spike-a.ts` on `ComPar-Lec01.pdf` (p.15: the memory-hierarchy slide; p.7: the
"50 years of microprocessor trend data" chart), rendered at 1200 px wide (`pdftoppm`), against
`https://api.meta.ai/v1`. Latency is wall time from this laptop, one call at a time.

| # | Try | Result | Decision |
| --- | --- | --- | --- |
| S1 | p.15 as a one-page PDF **file part** (`{type:"file", file:{file_data:"data:application/pdf;base64,…"}}`) to `muse-spark-1.3` on `/chat/completions`, asked for every figure and table | **Pass.** All three panels transcribed as Markdown tables with every row and value right (L1 ~32 KB <1 ns … Lustre ~ms). 23 s; 1,522 in / 2,659 out tokens (2,253 of them reasoning) | Works, but we send **images**: the browser renders them anyway for the viewer, the tutor (`PageImages`) and SAM, and one image per page keeps each call small |
| S2 | p.15 as a PNG **image part** with `response_format: json_schema` (strict), raw; and the same through `ModelProvider.structured` (LangChain, `jsonSchema`) | **Pass, both.** Valid JSON matching `{ figures: [{ kind, caption, table_markdown, latex, teaches }] }`; tables complete. Raw: 10.4 s, 1,075 in / 2,558 out. LangChain: 10.9 s | Vision goes through raw `metaFetch` in `src/meta/vision.ts` (`response_format` + `reasoning_effort: "low"`), so it has its own timeout and retries and doesn't need `src/models.ts` (stream B's file) to carry image parts |
| S2b | p.7 (a chart) asked for **normalised bounding boxes** and a one-word `sam_prompt` | Box 0.235–0.86 × 0.285–0.93 against the true 0.225–0.81 × 0.29–0.92 (title and legend included); `sam_prompt: "chart"`. 4.3 s with `reasoning_effort: "low"` (504 out tokens), 6.7 s without (1,087) | Spark's box is the fallback crop; `low` effort is enough |
| S3 | `sam-3.1` on `/v1/responses` (`input_text` + `input_image` data URL, `stream: false`) with "figure", "table", "chart" | **Partial.** Non-streaming works (1–2.4 s, `usage.images_processed: 1`). Output is special-token text, `<\|box;x1=…;y1=…;x2=…;y2=…;w=1200;h=676\|><\|mask;…\|>`. On the slide, "table", "figure", "card", "text box" return **nothing**; "rectangle" returns 17 cells; on p.7, "chart" / "graph" / "scatter plot" return the plot area (axes only, 333–833 × 230–545 px) | SAM is a natural-image segmenter: it needs a concrete noun, not a layout word. Spark names the object (`sam_prompt`) and gives a box; SAM refines it; code takes the SAM box that overlaps Spark's (IoU ≥ 0.3), unioned with Spark's box so titles and legends stay in, else Spark's box alone |

## Cost and latency per figure-bearing page

- Spark vision, `low` effort: ~1.1k input + ~0.5–2.5k output tokens ≈ **$0.002–0.011 per page**, 4–10 s.
- SAM: ~1.5 s per prompt; billed per image (no token usage reported; price not published where we looked).
- A 24-slide lecture with ~10 figure pages: ~10 vision + ~10 SAM calls, about **$0.10 and 1–2 minutes** at
  concurrency 4. Fits the build's call budget (400) with room.

## Decisions

1. **Images, not file parts.** The browser renders figure-bearing pages to JPEG (≤ 1200 px, ≤ 150 KB) and uploads them (A7.1).
2. **Crops are boxes, not new images.** A figure is stored as a box on its page image (`hl_figures` keeps the box
   and caption, not bytes); the browser shows the crop by scaling the page image inside a clipped frame. The Worker
   never decodes an image, and storage is paid once per page.
3. **Vision through `metaFetch`** with strict JSON schema, `reasoning_effort: "low"`, 60 s timeout, 2 retries.
4. If vision or SAM fails, the build continues text-only and says so in its warnings.
