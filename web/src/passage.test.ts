import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findPassage, markItems, type TextItem } from "./passage.js";

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
