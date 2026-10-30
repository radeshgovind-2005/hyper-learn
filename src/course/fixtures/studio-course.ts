import type { Option, QuizItem, WrongAnswerTag } from "../../assessment/items.js";
import type { CheckQuestion } from "../../interventions/templates.js";
import type { Scenario } from "../../simulation/scenarios.js";
import type { Block, CourseSnapshot, LessonNode, Section } from "../compile.js";
import type { Citation, Objective } from "../schema.js";
import type { Source } from "../sources.js";

// A small made-up course in the shape a generated (Studio) course has: objectives, an exam pool per
// lesson with `exam` config, text blocks that cite source pages, and a check after each section.
// For tests in every workstream. The content is invented for this fixture.

export const STUDIO_COURSE_ID = "caching-basics";
const SOURCE = "caching-notes";

/** The notes the course is "built" from: one Markdown source, a page per topic. */
export const STUDIO_SOURCES: Source[] = [
  {
    id: SOURCE,
    name: "caching-notes.md",
    role: "material",
    pages: [
      "A cache is a small, fast store in front of a slower one. Every read checks the cache first. If the value is there, that is a hit. If not, that is a miss: the value is fetched from the slower store, returned, and usually kept in the cache for next time. A miss is normal, not an error.",
      "The hit ratio is hits divided by all reads (hits plus misses). 80 hits in 100 reads is a hit ratio of 0.8. The first read of any value is always a miss (a cold miss), so a fresh cache starts at a low ratio.",
      "A full cache must evict an entry to make room for a new one. LRU (least recently used) evicts the entry that has gone unused the longest, however early or late it was added. FIFO evicts the entry that was added first, even if it is read all the time.",
      "A bigger cache holds more entries, so it usually hits more often, but with diminishing returns: once the working set (the values in active use) fits, extra space barely helps, and doubling the size does not double the ratio.",
      "When the data in the store changes, the cached copy becomes stale. Eviction does not fix this: it only removes entries to free space. A time to live (TTL) expires entries after a set time; explicit invalidation deletes the entry when the data is written.",
      "Write-through writes to the cache and the store together, so the cache never holds a value the store lacks. Cache-aside writes to the store and deletes the cached entry; the next read misses and loads the new value. Writing only to the cache loses data if the cache is cleared.",
    ],
  },
];

const cite = (...pages: number[]): Citation[] => pages.map((page) => ({ source: SOURCE, page }));

// ─── Item helpers ────────────────────────────────────────────────────

type Wrong = [text: string, tag?: WrongAnswerTag];
const wrong = ([text, tag = {}]: Wrong): Option => ({ text, correct: false, ...tag });

/** A single-choice item: the right option first, then the wrong ones. */
const single = (id: string, objective: string, prompt: string, right: string, wrongs: Wrong[], pilot = false): QuizItem => ({
  type: "single_choice",
  id,
  objective,
  prompt,
  pilot,
  options: [{ text: right, correct: true }, ...wrongs.map(wrong)],
});

const check = (prompt: string, right: [string, string], wrongs: [text: string, misconception: string | null, feedback: string][]): CheckQuestion => ({
  prompt,
  options: [
    { text: right[0], correct: true, misconception: null, feedback: right[1] },
    ...wrongs.map(([text, misconception, feedback]) => ({ text, correct: false, misconception, feedback })),
  ],
});

const section = (lesson: string, slug: string, title: string, paragraphs: [string, Citation[]][], k: CheckQuestion, objective: string): Section => {
  const id = `${lesson}/${slug}`;
  const blocks: Block[] = paragraphs.map(([markdown, cites], i) => ({ id: `${id}/p${i + 1}`, kind: "paragraph", markdown, cites, archived: false }));
  blocks.push({ id: `${id}/k1`, kind: "check", check: k, objective, archived: false });
  return { id, title, blocks, archived: false };
};

// ─── Lesson 1: hits and misses ───────────────────────────────────────

const hits: LessonNode = {
  id: "cache-hits",
  title: "Hits and misses",
  summary: "What a cache does on every read, and how to measure how well it works.",
  prerequisites: [],
  exam: { per_objective: 1 },
  archived: false,
  sections: [
    section(
      "cache-hits",
      "hits-and-misses",
      "Hits and misses",
      [
        ["A cache is a small, fast store in front of a slower one. Every read checks the cache first.", cite(1)],
        ["Found there, the read is a **hit**. Otherwise it is a **miss**: the value comes from the slower store and is usually kept for next time. A miss is normal.", cite(1)],
      ],
      check(
        "A read finds nothing in the cache. What happens next?",
        ["The value is fetched from the store and usually kept in the cache", "Right: a miss falls through to the store."],
        [
          ["The read fails with an error", "miss-is-error", "A miss isn't a failure; the slower store still has the value."],
          ["The cache makes up a default value", null, "Caches never invent values; they fetch them."],
        ],
      ),
      "tell-hit-from-miss",
    ),
    section(
      "cache-hits",
      "hit-ratio",
      "The hit ratio",
      [["The **hit ratio** is hits divided by all reads. 80 hits in 100 reads is 0.8. The first read of a value is always a miss.", cite(2)]],
      check(
        "30 hits and 10 misses. What is the hit ratio?",
        ["0.75", "Right: 30 of 40 reads hit."],
        [["3", "ratio-over-misses", "That divides hits by misses; the ratio is over all reads."]],
      ),
      "compute-hit-ratio",
    ),
  ],
  quiz: [
    single("hits-1", "tell-hit-from-miss", "A read finds the value in the cache. This is a…", "hit", [["miss"], ["eviction"]]),
    single("hits-2", "tell-hit-from-miss", "What does a miss mean?", "The value wasn't cached, so it comes from the slower store", [
      ["Something went wrong and the read failed", { misconception: "miss-is-error" }],
      ["The store has lost the value"],
    ]),
    {
      type: "ordering",
      id: "hits-3",
      objective: "tell-hit-from-miss",
      prompt: "Put the steps of a read that misses in order.",
      pilot: false,
      steps: ["Check the cache", "Fetch the value from the store", "Keep the value in the cache", "Return the value"],
      patterns: [{ first: 1, second: 0 }],
    },
    single("hits-4", "compute-hit-ratio", "90 hits and 10 misses. Hit ratio?", "0.9", [["9", { misconception: "ratio-over-misses" }], ["0.1"]]),
    single("hits-5", "compute-hit-ratio", "Why does a freshly started cache have a low hit ratio?", "Every value's first read is a miss", [
      ["Misses are errors that a new cache hasn't fixed yet", { misconception: "miss-is-error" }],
      ["New caches are slower"],
    ]),
    {
      type: "two_tier",
      id: "hits-6",
      objective: "compute-hit-ratio",
      prompt: "Cache A: 50 hits, 50 misses. Cache B: 60 hits, 20 misses. Which has the higher hit ratio?",
      pilot: false,
      options: [
        { text: "B", correct: true },
        { text: "A", correct: false },
      ],
      reason_prompt: "Why?",
      reasons: [
        { text: "0.75 of B's reads hit, against 0.5 of A's", correct: true },
        { text: "B's hits divided by its misses is 3, A's is 1", correct: false, misconception: "ratio-over-misses" },
        { text: "B had fewer reads", correct: false },
      ],
    },
    single("hits-7", "compute-hit-ratio", "1 hit, 3 misses. Hit ratio?", "0.25", [["0.33", { misconception: "ratio-over-misses" }], ["0.75"]], true),
  ],
};

// ─── Lesson 2: eviction ──────────────────────────────────────────────

const gapHits = { reveals_gap_in: "cache-hits" } as const;

const eviction: LessonNode = {
  id: "eviction",
  title: "Eviction",
  summary: "What a full cache throws out, and how much a bigger cache helps.",
  prerequisites: ["cache-hits"],
  exam: { per_objective: 1 },
  archived: false,
  sections: [
    section(
      "eviction",
      "lru",
      "Least recently used",
      [
        ["A full cache must **evict** an entry to make room.", cite(3)],
        ["**LRU** evicts the entry unused the longest, however early it was added. FIFO evicts the entry added first.", cite(3)],
      ],
      check(
        "Under LRU, which entry goes first?",
        ["The one unused for the longest time", "Right: recency of use decides, not order of arrival."],
        [["The one added first", "lru-evicts-oldest-inserted", "That's FIFO. LRU looks at when an entry was last used."]],
      ),
      "apply-lru",
    ),
    section(
      "eviction",
      "sizing",
      "How big a cache?",
      [["A bigger cache hits more often, with diminishing returns once the working set fits.", cite(4)]],
      check(
        "The working set already fits in the cache. Doubling the cache will…",
        ["barely change the hit ratio", "Right: there's little left to gain."],
        [["double the hit ratio", "bigger-always-better", "Returns diminish; the ratio can't pass 1 anyway."]],
      ),
      "judge-cache-size",
    ),
  ],
  quiz: [
    single("evict-1", "apply-lru", "An LRU cache holds A (used 1 s ago), B (used 9 s ago), C (used 4 s ago). Which is evicted?", "B", [
      ["A, because it was added first", { misconception: "lru-evicts-oldest-inserted" }],
      ["C, the one with the lowest hit ratio", gapHits],
    ]),
    single("evict-2", "apply-lru", "Why does a cache evict entries at all?", "It is full and needs room for a new value", [
      ["Because a miss is an error to clean up", { ...gapHits, misconception: "miss-is-error" }],
      ["To make reads slower"],
    ]),
    {
      type: "multi_select",
      id: "evict-3",
      objective: "apply-lru",
      prompt: "Which are true of LRU? Pick every one.",
      pilot: false,
      options: [
        { text: "Reading an entry protects it from eviction for a while", correct: true },
        { text: "It evicts the entry unused the longest", correct: true },
        { text: "It evicts the entry added first", correct: false, misconception: "lru-evicts-oldest-inserted" },
        { text: "It raises the hit ratio by counting misses as hits", correct: false, ...gapHits },
      ],
    },
    single("evict-4", "judge-cache-size", "A cache's hit ratio is 0.6. Doubling its size will most likely…", "raise it somewhat, by less than double", [
      ["make it 1.2", { misconception: "bigger-always-better" }],
      ["lower it, since more entries mean more misses", gapHits],
    ]),
    single("evict-5", "judge-cache-size", "When does extra cache space stop helping much?", "Once the working set fits", [
      ["Never: twice the space is twice the hits", { misconception: "bigger-always-better" }],
      ["Once the hit ratio is computed as hits over misses", gapHits],
    ]),
    single("evict-6", "judge-cache-size", "After a cache is resized, its first reads of each value are…", "misses, until the values are cached again", [
      ["hits, since the cache is bigger", gapHits],
      ["errors", { ...gapHits, misconception: "miss-is-error" }],
    ]),
  ],
};

// ─── Lesson 3: invalidation ──────────────────────────────────────────

const gapEviction = { reveals_gap_in: "eviction" } as const;

const invalidation: LessonNode = {
  id: "invalidation",
  title: "Keeping data fresh",
  summary: "Why cached values go stale, and the write strategies that keep them correct.",
  prerequisites: ["eviction"],
  exam: { per_objective: 1 },
  archived: false,
  sections: [
    section(
      "invalidation",
      "stale-data",
      "Stale data",
      [["When the store changes, the cached copy is **stale**. Eviction doesn't fix this; a TTL or an explicit delete does.", cite(5)]],
      check(
        "A price changed in the database, but readers still see the old one. What fixes it?",
        ["Deleting or expiring the cached entry", "Right: invalidation removes the stale copy."],
        [["Waiting for eviction", "eviction-prevents-staleness", "Eviction frees space; it may keep a stale entry for a long time."]],
      ),
      "explain-staleness",
    ),
    section(
      "invalidation",
      "write-strategies",
      "Write strategies",
      [
        ["**Write-through** writes cache and store together. **Cache-aside** writes the store and deletes the cached entry.", cite(6)],
        ["Writing only to the cache loses data if the cache is cleared.", cite(6)],
      ],
      check(
        "Which write keeps no stale copy and loses nothing if the cache is cleared?",
        ["Write to the store, then delete the cached entry", "Right: that's cache-aside."],
        [["Write to the cache only", "cache-is-source-of-truth", "The store never gets the value; clearing the cache loses it."]],
      ),
      "choose-write-strategy",
    ),
  ],
  quiz: [
    single("fresh-1", "explain-staleness", "When does a cached value become stale?", "When the store's data changes and the cache still has the old copy", [
      ["Only when it is evicted", { misconception: "eviction-prevents-staleness" }],
      ["When LRU marks it as the oldest entry", gapEviction],
    ]),
    single("fresh-2", "explain-staleness", "An entry is read constantly and the data behind it changed. Under LRU it will…", "stay cached, stale, until it is invalidated", [
      ["be evicted soon, since it was added long ago", { ...gapEviction, misconception: "lru-evicts-oldest-inserted" }],
      ["refresh itself"],
    ]),
    single("fresh-3", "explain-staleness", "What does a TTL do?", "Expires an entry a set time after it was cached", [
      ["Evicts the least recently used entry", gapEviction],
      ["Nothing; eviction already keeps entries fresh", { misconception: "eviction-prevents-staleness" }],
    ]),
    single("fresh-4", "choose-write-strategy", "What does write-through do?", "Writes to the cache and the store together", [
      ["Writes to the cache; the store catches up later by itself", { misconception: "cache-is-source-of-truth" }],
      ["Writes into the least recently used slot, which keeps it fresh", gapEviction],
    ]),
    single("fresh-5", "choose-write-strategy", "With cache-aside, what happens on the next read after a write?", "A miss, which loads the new value", [
      ["A hit on the old value", { misconception: "cache-is-source-of-truth" }],
      ["An eviction of the oldest entry", gapEviction],
    ]),
    {
      type: "multi_select",
      id: "fresh-6",
      objective: "choose-write-strategy",
      prompt: "Which writes leave no stale copy in the cache? Pick every one.",
      pilot: false,
      options: [
        { text: "Write-through: write the cache and the store together", correct: true },
        { text: "Cache-aside: write the store, then delete the cached entry", correct: true },
        { text: "Write the store and let LRU evict the old copy", correct: false, ...gapEviction },
        { text: "Write the cache only", correct: false, misconception: "cache-is-source-of-truth" },
      ],
    },
  ],
};

export const STUDIO_OBJECTIVES: Objective[] = [
  { id: "tell-hit-from-miss", lesson: "cache-hits", statement: "Say whether a read is a hit or a miss and what happens next", sections: ["cache-hits/hits-and-misses"] },
  { id: "compute-hit-ratio", lesson: "cache-hits", statement: "Compute a hit ratio from counts of hits and misses", sections: ["cache-hits/hit-ratio"] },
  { id: "apply-lru", lesson: "eviction", statement: "Pick the entry an LRU cache evicts", sections: ["eviction/lru"] },
  { id: "judge-cache-size", lesson: "eviction", statement: "Predict how resizing a cache changes its hit ratio", sections: ["eviction/sizing"] },
  { id: "explain-staleness", lesson: "invalidation", statement: "Explain why cached data goes stale and what removes it", sections: ["invalidation/stale-data"] },
  { id: "choose-write-strategy", lesson: "invalidation", statement: "Choose a write strategy that keeps the cache correct", sections: ["invalidation/write-strategies"] },
];

const SNAPSHOT: CourseSnapshot = {
  course_id: STUDIO_COURSE_ID,
  title: "Caching basics",
  version: "1.0.0",
  lessons: [hits, eviction, invalidation],
  misconceptions: [
    { id: "miss-is-error", lesson: "cache-hits", belief: "A cache miss means something went wrong" },
    { id: "ratio-over-misses", lesson: "cache-hits", belief: "The hit ratio is hits divided by misses" },
    { id: "lru-evicts-oldest-inserted", lesson: "eviction", belief: "LRU evicts the entry that was added first" },
    { id: "bigger-always-better", lesson: "eviction", belief: "Doubling a cache doubles its hit ratio" },
    { id: "eviction-prevents-staleness", lesson: "invalidation", belief: "Eviction keeps cached data up to date" },
    { id: "cache-is-source-of-truth", lesson: "invalidation", belief: "Writing to the cache is enough; the store catches up by itself" },
  ],
  objectives: STUDIO_OBJECTIVES,
};

/** A fresh copy of the course's v1.0.0, safe to mutate. */
export const studioSnapshot = (): CourseSnapshot => structuredClone(SNAPSHOT);

/** A scenario for simulating the fixture: invalidation published without its eviction prerequisite. */
export const STUDIO_MISSING_PREREQ: Scenario = {
  id: "studio-missing-prereq",
  title: "Missing prerequisite: eviction → invalidation",
  description: "Learners can start invalidation before eviction; they fail it with answers that reveal the eviction gap.",
  seed: 909,
  removeEdges: [["invalidation", "eviction"]],
  expected: { action: "add_prerequisite", node_id: "invalidation", target_node_id: "eviction", misconception_id: null },
};

/** The same course with nothing planted: the reference Curator should find nothing to restructure. */
export const STUDIO_CONTROL: Scenario = {
  id: "studio-control",
  title: "Control: nothing planted",
  description: "The published graph matches the course; only normal noise.",
  seed: 919,
  expected: { action: "flag_for_review", node_id: null, target_node_id: null, misconception_id: null },
};
