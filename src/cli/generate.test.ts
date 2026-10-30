import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { courseFromSnapshot, type CourseSnapshot } from "../course/compile.js";
import { MAX_PAGE_CHARS } from "../course/sources.js";
import { EXAM, NOTES } from "../generate/fixtures.test-helpers.js";
import { parseArgs, runGenerate } from "./generate.js";
import { readSourceFiles } from "./generate-sources.js";

const dir = mkdtempSync(join(tmpdir(), "hl-generate-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

/** A minimal PDF with one line of text per page, offsets computed so pdftotext accepts it. */
function tinyPdf(pages: string[]): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((text, i) => {
      const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

const hasPdftotext = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("generate CLI arguments", () => {
  it("reads the title, options, roles and files", () => {
    const args = parseArgs(["--title", "Bramble Clocks", "--goal", "Keep time", "notes.md", "--assessment", "exam.pdf", "--per-objective", "2", "--no-review", "--dry-run"]);
    assert.equal(args.input.course_id, "bramble-clocks");
    assert.equal(args.input.goal, "Keep time");
    assert.deepEqual(args.files, [{ path: "notes.md" }, { path: "exam.pdf", role: "assessment" }]);
    assert.deepEqual(args.options, { perObjective: 2, review: false });
    assert.equal(args.dryRun, true);
    assert.equal(args.out, "generated");
  });

  it("refuses a missing title, no files and unknown options", () => {
    assert.throws(() => parseArgs(["notes.md"]), /--title is required/);
    assert.throws(() => parseArgs(["--title", "X"]), /at least one file/);
    assert.throws(() => parseArgs(["--title", "X", "--colour", "red", "a.md"]), /Unknown option --colour/);
    assert.throws(() => parseArgs(["--title", "X", "--max-calls", "0", "a.md"]), /positive whole number/);
  });
});

describe("generate CLI files", () => {
  it("reads .md and .txt as one page and .pages.json as pages, cutting long pages", () => {
    const md = file("notes.md", "# Notes\nOne page.");
    const json = file("deck.pages.json", JSON.stringify(["first", "second", "x".repeat(MAX_PAGE_CHARS + 5)]));
    const { sources, notes } = readSourceFiles([{ path: md }, { path: json, role: "material" }]);
    assert.deepEqual(sources[0], { id: "s1", name: "notes.md", pages: ["# Notes\nOne page."] });
    assert.equal(sources[1]!.role, "material");
    assert.equal(sources[1]!.pages.length, 3);
    assert.equal(sources[1]!.pages[2]!.length, MAX_PAGE_CHARS);
    assert.match(notes[0]!, /deck\.pages\.json page 3 was cut/);
  });

  it("refuses unknown file types and malformed page lists", () => {
    assert.throws(() => readSourceFiles([{ path: file("slides.pptx", "x") }]), /use \.md, \.txt, \.pages\.json or \.pdf/);
    assert.throws(() => readSourceFiles([{ path: file("bad.pages.json", '{"pages": 1}') }]), /JSON array of page strings/);
  });

  it("reads a PDF page by page with pdftotext", { skip: !hasPdftotext && "pdftotext is not installed" }, () => {
    const { sources } = readSourceFiles([{ path: file("lec01.pdf", tinyPdf(["Page one text", "Page two text"])) }]);
    assert.equal(sources[0]!.pages.length, 2);
    assert.match(sources[0]!.pages[0]!, /Page one text/);
    assert.match(sources[0]!.pages[1]!, /Page two text/);
  });
});

describe("generate CLI dry run", () => {
  it("builds from files with canned models and writes snapshot.json and report.md", async () => {
    const notes = file("bramble-notes.pages.json", JSON.stringify(NOTES.pages));
    const exam = file("winter-exam.txt", EXAM.pages[0]!);
    const out = join(dir, "out");
    const lines: string[] = [];
    const code = await runGenerate(["--title", "Bramble Clocks", "--dry-run", "--out", out, notes, exam], (line) => lines.push(line));
    assert.equal(code, 0);
    const snapshot = JSON.parse(readFileSync(join(out, "snapshot.json"), "utf8")) as CourseSnapshot;
    assert.doesNotThrow(() => courseFromSnapshot(snapshot));
    assert.equal(snapshot.course_id, "bramble-clocks");
    assert.match(readFileSync(join(out, "report.md"), "utf8"), /Built \*\*3 lessons\*\*/);
    assert.ok(lines.some((line) => line.startsWith("[stress]")));
  });

  it("writes only the report when the build fails", async () => {
    const out = join(dir, "out-fail");
    const code = await runGenerate(["--title", "Exams only", "--dry-run", "--out", out, file("final-exam.txt", EXAM.pages[0]!)], () => {});
    assert.equal(code, 1);
    assert.match(readFileSync(join(out, "report.md"), "utf8"), /No teaching material/);
    assert.throws(() => readFileSync(join(out, "snapshot.json")));
  });
});
