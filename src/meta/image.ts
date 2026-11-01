import { type MetaClientConfig, metaFetch } from "./client.js";

// Muse Image (muse-image-1.0) for the tutor's diagrams. The prompt is built by code: a fixed style
// prefix, the section's title and a short description from the model with anything but plain text
// removed, all under a length cap, so the model never sends raw instructions to the image endpoint.
// The API returns base64 (webp by default, about 230 KB) and can't be asked for a smaller file, and
// workerd has no image codec, so an image over MAX_IMAGE_BYTES is refused rather than re-encoded.

export interface GeneratedImage {
  mime: "image/webp" | "image/png" | "image/jpeg";
  base64: string;
}

/** Makes one image from a finished prompt. The Worker passes Meta's; tests a fake. */
export type ImageMaker = (prompt: string) => Promise<GeneratedImage>;

export const IMAGE_MODEL = "muse-image-1.0";
export const IMAGE_STYLE = "Clean labelled educational diagram, white background, flat colours, large readable labels, no decoration.";
export const MAX_IMAGE_BYTES = 400_000;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;

/** Letters, digits, spaces and ordinary punctuation only; no URLs; collapsed and cut to `max`. */
export function plainText(text: string, max: number): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[^\p{L}\p{N}\s.,;:()'"%+\-/→<>=?!&]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function imagePrompt(title: string, description: string): string {
  return `${IMAGE_STYLE} Topic: ${plainText(title, MAX_TITLE_CHARS)}. Show: ${plainText(description, MAX_DESCRIPTION_CHARS)}`;
}

/** The decoded size of a base64 string. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The image type from its first bytes (the API says the format, but the bytes are what the browser renders). */
export function sniffMime(base64: string): GeneratedImage["mime"] | null {
  const head = atob(base64.slice(0, 24));
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  return null;
}

export async function promptHash(prompt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Meta's image endpoint: one image, default size and format. Errors carry the API's message, never the key. */
export function metaImageMaker(config: MetaClientConfig): ImageMaker {
  return async (prompt) => {
    const res = await metaFetch({ timeoutMs: 90_000, retries: 1, ...config }, "/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1 }),
    });
    const body = (await res.json().catch(() => null)) as { data?: { b64_json?: string }[]; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(`The image model refused (${res.status}): ${body?.error?.message ?? "no message"}`);
    const base64 = body?.data?.[0]?.b64_json;
    if (!base64) throw new Error("The image model returned no image");
    const mime = sniffMime(base64);
    if (!mime) throw new Error("The image model returned something that isn't an image");
    return { mime, base64 };
  };
}
