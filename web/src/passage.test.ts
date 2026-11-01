import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findPassage, findQuote, markItems, type TextItem } from "./passage.js";

// The viewer highlights the cited lines on the real page: scored on pdf.js text items, not only on lines.

/** Items as pdf.js gives a slide: a title, then lines that each come in a few pieces. */
const slide: TextItem[] = [
  { str: "Parallel Hardware Landscape", hasEOL: true },
  { str: "Multicore CPU", hasEOL: true },
  { str: "L1 cache (per core): ", hasEOL: false },
  { str: "private, fastest level", hasEOL: true },
  { str: "L2 (per core): ~256 KB, ~4 ns", hasEOL: true },
  { str: "", hasEOL: true },
  { str: "GPU", hasEOL: true },
  { str: "Registers: per-thread, ~1 cycle", hasEOL: true },
  { str: "Shared memory: per-block, ~5 cycles", hasEOL: true },
];

describe("findPassage", () => {
  it("marks the best line and close neighbours", () => {
    const { pieces, marked } = findPassage("Intro line\nGPUs have registers per thread\nand shared memory per block\nUnrelated end", "Each GPU thread has registers; each block shares memory.");
    assert.ok(marked);
    assert.match(pieces.slice(marked[0], marked[1] + 1).join(""), /registers per thread/);
  });

  it("marks nothing when the block shares too little", () => {
    assert.equal(findPassage("Alpha beta\nGamma delta", "Something else entirely").marked, null);
    assert.equal(findPassage("Alpha beta", undefined).marked, null);
  });
});

describe("markItems", () => {
  it("marks the items of the matching lines, across pieces of one line", () => {
    const marked = markItems(slide, "On a GPU, registers are per thread and take about one cycle; shared memory is per block, about five cycles.");
    assert.deepEqual(marked, [7, 8]);
  });

  it("marks every piece of a line split into several items", () => {
    const marked = markItems(slide, "The L1 cache is private to each core and the fastest level.");
    assert.ok(marked.includes(2) && marked.includes(3), `marked ${marked.join()}`);
    assert.ok(!marked.includes(7));
  });

  it("marks nothing for an unrelated block, an empty page or no block", () => {
    assert.deepEqual(markItems(slide, "Photosynthesis converts light into sugar."), []);
    assert.deepEqual(markItems([], "anything at all here"), []);
    assert.deepEqual(markItems(slide, undefined), []);
  });

  it("never marks an empty item", () => {
    const marked = markItems(slide, "Multicore CPU L1 per core L2 per core GPU registers");
    assert.ok(!marked.includes(5));
  });
});

describe("quotes", () => {
  it("are found whatever the case, punctuation and line breaks, and marked exactly", () => {
    const page = "Amdahl's law:\nthe serial frac-\ntion limits speed-up. Gustafson disagrees.";
    const { pieces, marked } = findPassage(page, "the serial frac tion limits");
    assert.deepEqual(marked, [1, 1]);
    assert.equal(pieces[1], "the serial frac-\ntion limits");
    assert.equal(findQuote(page, "the parallel part limits"), null);
    assert.equal(findQuote(page, "the serial"), null, "too short to mean anything");
  });

  it("mark exactly the items the quote covers", () => {
    const marked = markItems(slide, "Registers: per-thread, ~1 cycle");
    assert.deepEqual(marked, [7]);
  });
});

describe("slides with numbers", () => {
  it("matches lines by their numbers too (the ComPar p.15 memory-hierarchy card)", () => {
    // As pdf.js gives that card: each line, then an empty item that ends it.
    const lines = ["Multicore CPU", "4 – 192 cores", "Memory Hierarchy", "L1 (per core): ~32 KB, <1 ns", "L2 (per core): ~256 KB, ~4 ns", "L3 (shared): 32–768 MB, ~30 ns", "DRAM: up to TBs, ~100 ns", "General-purpose · OS · databases · servers"];
    const card: TextItem[] = lines.flatMap((str) => [{ str }, { str: "", hasEOL: true }]);
    // The block the real build wrote from that page.
    const block =
      "A multicore CPU is a general-purpose chip for OS, databases and servers with 4 – 192 cores, where a core is one processing unit. Its memory hierarchy means layers from small-close to large-far, with latency meaning access time. In order it is L1 (per core): ~32 KB, <1 ns, where L1 is the private first cache, then L2 (per core): ~256 KB, ~4 ns, then L3 (shared): 32–768 MB, ~30 ns, where shared means used by all cores, then DRAM, the large main memory: up to TBs, ~100 ns.";
    const marked = markItems(card, block).map((i) => card[i]!.str);
    for (const line of ["L1 (per core): ~32 KB, <1 ns", "L2 (per core): ~256 KB, ~4 ns", "L3 (shared): 32–768 MB, ~30 ns"]) assert.ok(marked.includes(line), `${line} in ${marked.join(" | ")}`);
    assert.ok(!marked.includes("General-purpose · OS · databases · servers"));
  });
});
