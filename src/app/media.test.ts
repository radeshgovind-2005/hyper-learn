import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseSnapshot } from "../course/bundle.js";
import { type CourseSnapshot, isTextBlock } from "../course/compile.js";
import { modelConfigFromEnv } from "../models.js";
import { sqlite } from "../node/sqlite.js";
import { MEDIA_LIMITS } from "../storage/media.js";
import type { CourseBuilder } from "./courses.js";
import { CourseService } from "./service.js";

// The original PDF next to its text: uploaded in chunks by the owner, read back by learners only for
// files their release cites, within per-file and per-course caps.

const NOW = "2026-11-01T12:00:00.000Z";
const ada = { userId: "user_ada", role: "learner" as const, name: "Ada" };
const KB = 1024;
const MB = 1024 * KB;

/** The featured course's content, citing s1 only. */
function citedSnapshot(): CourseSnapshot {
  const snapshot = baseSnapshot();
  const blocks = snapshot.lessons.flatMap((l) => l.sections.flatMap((s) => s.blocks.filter(isTextBlock)));
  blocks[0]!.cites = [{ source: "s1", page: 1 }];
  return snapshot;
}

async function course({ publish = true } = {}) {
  const builder: CourseBuilder = async () => ({ ok: true, snapshot: citedSnapshot(), report: { steps: [], model_calls: 0, warnings: [] } });
  const s = new CourseService(sqlite(), {
    course: "studio",
    builder,
    now: () => NOW,
    ownerModels: {
      secret: "test-only-secret-0123456789abcdefghijkl",
      config: { ...modelConfigFromEnv({ MODEL_BASE_URL: "https://models.example.com/v1" }), apiKey: "" },
      choices: ["muse-spark-1.3"],
    },
  });
  s.initialise({ id: "c-abcdefghijkl", title: "Bramble Clocks", description: "", owner: ada });
  s.addSource({ name: "Bramble-Lec01.pdf", role: "material", pages: ["Stems grow.", "Notches mark hours."] });
  s.addSource({ name: "Bramble-Lec02.pdf", role: "material", pages: ["Prune side shoots."] });
  await s.setModelKey("sk-meta-secret-123", "muse-spark-1.3");
  await s.continueBuild(s.beginBuild());
  if (publish) s.publish();
  return s;
}

/** A fake PDF of `size` bytes: the header, then a pattern that changes every byte. */
function fakePdf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  for (let i = 9; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
}

const chunksOf = (bytes: Uint8Array, size = MEDIA_LIMITS.chunkBytes) =>
  Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => Buffer.from(bytes.subarray(i * size, (i + 1) * size)).toString("base64"));

function upload(s: CourseService, id: string, bytes: Uint8Array) {
  const chunks = chunksOf(bytes);
  chunks.forEach((chunk, seq) => s.addSourceFileChunk(id, seq, chunk, chunks.length));
}

function readBack(read: (seq: number) => { total: number; base64: string }): Uint8Array {
  const first = read(0);
  const parts = [first, ...Array.from({ length: first.total - 1 }, (_, i) => read(i + 1))].map((c) => Buffer.from(c.base64, "base64"));
  return new Uint8Array(Buffer.concat(parts));
}

describe("original files", () => {
  it("stores 6 MB in chunks and gives it back byte for byte, to the owner and to learners", async () => {
    const s = await course();
    const pdf = fakePdf(6 * MB + 123);
    upload(s, "s1", pdf);
    assert.deepEqual(s.sourceList()[0]!.file, { size: pdf.length, chunks: 13, total: 13 });
    assert.equal(s.sourceList()[1]!.file, undefined, "s2 has no original");
    assert.deepEqual(readBack((seq) => s.ownerSourceFileChunk("s1", seq)), pdf);
    assert.deepEqual(readBack((seq) => s.sourceFileChunk("user_bob", "s1", seq)), pdf);
    assert.deepEqual(s.citedSources("user_bob"), [{ id: "s1", name: "Bramble-Lec01.pdf", pages: 2, file: { size: pdf.length, chunks: 13, total: 13 } }]);
  });

  it("refuses learners a file their release doesn't cite, and one the owner hid", async () => {
    const s = await course();
    upload(s, "s1", fakePdf(10 * KB));
    upload(s, "s2", fakePdf(10 * KB));
    assert.throws(() => s.sourceFileChunk("user_bob", "s2", 0), /isn't shared with learners/);
    assert.throws(() => s.sourceFileChunk("user_bob", "s9", 0), /isn't shared with learners/);
    s.setSourceShared("s1", false);
    assert.throws(() => s.sourceFileChunk("user_bob", "s1", 0), /isn't shared with learners/);
    // The owner still reads both.
    assert.equal(s.ownerSourceFileChunk("s2", 0).total, 1);
  });

  it("is idempotent per chunk, and a shorter re-upload drops the old tail", async () => {
    const s = await course();
    const chunks = chunksOf(fakePdf(3 * MEDIA_LIMITS.chunkBytes));
    chunks.forEach((c, seq) => s.addSourceFileChunk("s1", seq, c, 3));
    s.addSourceFileChunk("s1", 1, chunks[1]!, 3);
    assert.deepEqual(s.sourceList()[0]!.file, { size: 3 * MEDIA_LIMITS.chunkBytes, chunks: 3, total: 3 });
    const small = chunksOf(fakePdf(100));
    s.addSourceFileChunk("s1", 0, small[0]!, 1);
    assert.deepEqual(s.sourceList()[0]!.file, { size: 100, chunks: 1, total: 1 });
    assert.throws(() => s.ownerSourceFileChunk("s1", 1), /No chunk 1/);
  });

  it("caps a chunk, a file at 25 MB and a course at 100 MB", async () => {
    const s = await course({ publish: false });
    const big = Buffer.alloc(MEDIA_LIMITS.chunkBytes + 1, 1).toString("base64");
    assert.throws(() => s.addSourceFileChunk("s1", 0, big, 1), /at most 512 KB/);
    assert.throws(() => s.addSourceFileChunk("s1", 0, "not base64!", 1), /base64/);
    assert.throws(() => s.addSourceFileChunk("s1", 0, Buffer.from("hello").toString("base64"), 1), /Only a PDF/);
    assert.throws(() => s.addSourceFileChunk("s1", 2, chunksOf(fakePdf(10))[0]!, 2), /seq is 0 to 1/);
    assert.throws(() => s.addSourceFileChunk("s9", 0, chunksOf(fakePdf(10))[0]!, 1), /No source/);
    assert.throws(() => s.addSourceFileChunk("s1", 0, chunksOf(fakePdf(10))[0]!, 51), /at most 25 MB/);

    // 25 MB fits exactly (50 chunks); a 51st chunk, the 26th MB, is refused.
    const full = chunksOf(fakePdf(25 * MB));
    assert.equal(full.length, 50);
    full.forEach((c, seq) => s.addSourceFileChunk("s1", seq, c, 50));
    assert.equal(s.sourceList()[0]!.file!.size, 25 * MB);
    s.addSourceFileChunk("s1", 49, full[49]!, 50); // replacing a chunk doesn't count it twice
    assert.throws(() => s.addSourceFileChunk("s1", 50, full[49]!, 51), /at most 25 MB/);

    // Three more full files fill the course's 100 MB; a fifth byte over is refused.
    for (const name of ["c.pdf", "d.pdf", "e.pdf"]) {
      const { id } = s.addSource({ name, pages: ["x"] });
      full.forEach((c, seq) => s.addSourceFileChunk(id, seq, c, 50));
    }
    assert.throws(() => s.addSourceFileChunk("s2", 0, chunksOf(fakePdf(10))[0]!, 1), /100 MB in all/);
  });

  it("removes a source's chunks with the source", async () => {
    const s = await course({ publish: false });
    upload(s, "s2", fakePdf(700 * KB));
    s.removeSource("s2");
    const again = s.addSource({ name: "Again.pdf", pages: ["x"] });
    assert.equal(again.id, "s3");
    assert.equal(s.sourceList().find((x) => x.id === "s3")!.file, undefined);
    // The bytes are gone, so they no longer count against the course.
    upload(s, "s3", fakePdf(10 * KB));
    assert.equal(s.sourceList().find((x) => x.id === "s3")!.file!.size, 10 * KB);
  });
});
