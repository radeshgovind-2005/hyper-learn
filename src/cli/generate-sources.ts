import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { MAX_PAGE_CHARS, type Source, type SourceRole } from "../course/sources.js";

// Reads the files given to `npm run generate` as sources, page by page. Node-only (files, pdftotext);
// in the app, text arrives already extracted.

export interface SourceFile {
  path: string;
  role?: SourceRole;
}

/** Page texts of a PDF, one per form feed that pdftotext writes between pages. */
function pdfPages(path: string): string[] {
  let text: string;
  try {
    text = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Can't read ${path}: pdftotext is not on PATH (install poppler-utils), or pass the text as .md, .txt or .pages.json`);
    }
    throw new Error(`pdftotext failed on ${path}: ${(error as Error).message}`);
  }
  const pages = text.split("\f");
  // pdftotext ends the last page with a form feed too.
  if (pages.length > 1 && pages.at(-1)!.trim() === "") pages.pop();
  return pages;
}

function pagesOf(path: string): string[] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pages.json")) {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value) || value.length === 0 || !value.every((page) => typeof page === "string")) {
      throw new Error(`${path} must hold a non-empty JSON array of page strings`);
    }
    return value as string[];
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return [readFileSync(path, "utf8")];
  if (lower.endsWith(".pdf")) return pdfPages(path);
  throw new Error(`Can't read ${path}: use .md, .txt, .pages.json or .pdf`);
}

/** Sources s1, s2… in the order given; pages longer than MAX_PAGE_CHARS are cut, and `notes` says so. */
export function readSourceFiles(files: readonly SourceFile[]): { sources: Source[]; notes: string[] } {
  const notes: string[] = [];
  const sources = files.map(({ path, role }, i): Source => {
    const pages = pagesOf(path).map((page, p) => {
      if (page.length <= MAX_PAGE_CHARS) return page;
      notes.push(`${basename(path)} page ${p + 1} was cut to ${MAX_PAGE_CHARS} characters`);
      return page.slice(0, MAX_PAGE_CHARS);
    });
    return { id: `s${i + 1}`, name: basename(path).slice(0, 200), pages, ...(role && { role }) };
  });
  return { sources, notes };
}
