import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashOf, parseHash } from "./deeplink.js";

const lessons = [
  { id: "why-parallelism-and-what-parallel-machin", sections: [{ id: "why-parallelism-and-what-parallel-machin/distributed-memory-interconnects-and-exa" }, { id: "why-parallelism-and-what-parallel-machin/old", archived: true }] },
  { id: "amdahl", sections: [{ id: "amdahl/intro" }] },
  { id: "gone", archived: true, sections: [{ id: "gone/intro" }] },
];

describe("parseHash", () => {
  it("lands on a lesson's section", () => {
    assert.deepEqual(parseHash("#why-parallelism-and-what-parallel-machin/distributed-memory-interconnects-and-exa", lessons), {
      lesson: "why-parallelism-and-what-parallel-machin",
      section: "why-parallelism-and-what-parallel-machin/distributed-memory-interconnects-and-exa",
    });
    assert.deepEqual(parseHash("amdahl/intro", lessons), { lesson: "amdahl", section: "amdahl/intro" });
    assert.deepEqual(parseHash("#amdahl%2Fintro", lessons), { lesson: "amdahl", section: "amdahl/intro" });
  });

  it("opens the lesson when there is no section, or the section no longer exists", () => {
    assert.deepEqual(parseHash("#amdahl", lessons), { lesson: "amdahl" });
    assert.deepEqual(parseHash("#amdahl/removed-section", lessons), { lesson: "amdahl" });
    assert.deepEqual(parseHash("#why-parallelism-and-what-parallel-machin/old", lessons), { lesson: "why-parallelism-and-what-parallel-machin" });
  });

  it("ignores a missing or archived lesson, an empty hash and bad encoding", () => {
    assert.equal(parseHash("#nope/intro", lessons), null);
    assert.equal(parseHash("#gone", lessons), null);
    assert.equal(parseHash("", lessons), null);
    assert.equal(parseHash("#", lessons), null);
    assert.equal(parseHash("#%E0%A4%A", lessons), null);
  });

  it("round-trips with hashOf", () => {
    assert.deepEqual(parseHash(hashOf("amdahl", "amdahl/intro"), lessons), { lesson: "amdahl", section: "amdahl/intro" });
    assert.deepEqual(parseHash(hashOf("amdahl"), lessons), { lesson: "amdahl" });
  });
});
