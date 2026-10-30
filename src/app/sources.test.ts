import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseSnapshot } from "../course/bundle.js";
import { type CourseSnapshot, isTextBlock, type TextBlock } from "../course/compile.js";
import type { Citation } from "../course/schema.js";
import { armOf } from "../measure/real.js";
import { modelConfigFromEnv } from "../models.js";
import { sqlite } from "../node/sqlite.js";
import type { CourseBuilder } from "./courses.js";
import { CourseService } from "./service.js";

// Learners open the pages their lessons cite; owners see every page and choose which files learners may open.

const NOW = "2026-10-30T12:00:00.000Z";
const ada = { userId: "user_ada", role: "learner" as const, name: "Ada" };

/** Every live text block of a snapshot, in order. */
const textBlocks = (snapshot: CourseSnapshot): TextBlock[] =>
  snapshot.lessons.flatMap((l) => l.sections.flatMap((s) => s.blocks.filter(isTextBlock)));

/** The featured course's content, with made-up citations: s1 and s2 cited by live blocks, s3 only by an archived one. */
function citedSnapshot(): CourseSnapshot {
  const snapshot = baseSnapshot();
  const blocks = textBlocks(snapshot);
  const cite = (i: number, cites: Citation[]) => void (blocks[i]!.cites = cites);
  cite(0, [{ source: "s1", page: 2 }]);
  cite(1, [{ source: "s1", page: 3 }, { source: "s2", page: 1 }]);
  cite(2, [{ source: "s3", page: 1 }]);
  blocks[2]!.archived = true;
  return snapshot;
}

/** A studio course built (by a fake builder) from four made-up files, then published unless `draft`. */
async function course({ draft = false } = {}) {
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
  s.addSource({ name: "Bramble-Lec01.pdf", role: "material", pages: ["Stems grow.", "Notches mark hours.", "Prune side shoots."] });
  s.addSource({ name: "winter-exam.pdf", role: "assessment", pages: ["Question 1. Why does a dry bed slow the clock?"] });
  s.addSource({ name: "old-notes.md", pages: ["Trellis history."] });
  s.addSource({ name: "project.md", role: "brief", pages: ["Build a clock."] });
  await s.setModelKey("sk-meta-secret-123", "muse-spark-1.3");
  await s.continueBuild(s.beginBuild());
  if (!draft) s.publish();
  return s;
}

describe("source pages for learners", () => {
  it("lists only teaching files that live blocks cite", async () => {
    const s = await course();
    // s2 is an assessment (never shown), s3 is cited only by an archived block, s4 is a brief nobody cites.
    assert.deepEqual(s.citedSources("user_bob"), [{ id: "s1", name: "Bramble-Lec01.pdf", pages: 3 }]);
  });

  it("opens any page of a listed file, and nothing else", async () => {
    const s = await course();
    assert.deepEqual(s.sourcePage("user_bob", "s1", 1), { source: { id: "s1", name: "Bramble-Lec01.pdf", pages: 3 }, page: 1, text: "Stems grow." });
    assert.equal(s.sourcePage("user_bob", "s1", 3).text, "Prune side shoots.");
    assert.throws(() => s.sourcePage("user_bob", "s1", 4), /pages 1 to 3/);
    assert.throws(() => s.sourcePage("user_bob", "s1", 0), /pages 1 to 3/);
    assert.throws(() => s.sourcePage("user_bob", "s1", 1.5), /pages 1 to 3/);
    assert.throws(() => s.sourcePage("user_bob", "s1", "1"), /pages 1 to 3/);
    for (const id of ["s2", "s3", "s4", "s9", 42]) assert.throws(() => s.sourcePage("user_bob", id, 1), /isn't shared with learners/);
  });

  it("follows the owner's switch, before and after publishing", async () => {
    const s = await course();
    assert.deepEqual(s.sourceList().map((x) => [x.id, x.shared]), [["s1", true], ["s2", true], ["s3", true], ["s4", true]]);
    assert.equal(s.setSourceShared("s1", false).shared, false);
    assert.deepEqual(s.citedSources("user_bob"), []);
    assert.throws(() => s.sourcePage("user_bob", "s1", 1), /isn't shared/);
    assert.equal(s.sourceList()[0]?.shared, false);
    s.setSourceShared("s1", true);
    assert.equal(s.citedSources("user_bob").length, 1);
    // Sharing an exam changes nothing for learners: its role keeps it hidden.
    s.setSourceShared("s2", true);
    assert.ok(!s.citedSources("user_bob").some((x) => x.id === "s2"));
    assert.throws(() => s.setSourceShared("s9", true), /No source/);
    assert.throws(() => s.setSourceShared("s1", "false"), /true or false/);
  });

  it("uses the release the learner is served during a trial on real learners", async () => {
    const s = await course();
    const live = s.releases.live();
    const snapshot = structuredClone(live.snapshot);
    textBlocks(snapshot)[2]!.archived = false; // the trial brings back the block that cites s3
    s.releases.add({ ...live, version: "1.0.1-trial.1", parent: "1.0.0", status: "trial", trial_source: "real", snapshot: { ...snapshot, version: "1.0.1-trial.1" } });
    const learners = Array.from({ length: 20 }, (_, i) => `user_${i}`);
    const treated = learners.find((id) => armOf(id, "1.0.1-trial.1") === "treatment")!;
    const control = learners.find((id) => armOf(id, "1.0.1-trial.1") === "control")!;
    assert.deepEqual(s.citedSources(treated).map((x) => x.id), ["s1", "s3"]);
    assert.deepEqual(s.citedSources(control).map((x) => x.id), ["s1"]);
    assert.equal(s.sourcePage(treated, "s3", 1).text, "Trellis history.");
    assert.throws(() => s.sourcePage(control, "s3", 1), /isn't shared/);
  });

  it("refuses learners on a draft, and has nothing to show on a built-in course", async () => {
    const draft = await course({ draft: true });
    assert.throws(() => draft.citedSources("user_bob"), /isn't published/);
    const featured = new CourseService(sqlite(), { now: () => NOW });
    assert.deepEqual(featured.citedSources("user_bob"), []);
    assert.throws(() => featured.sourcePage("user_bob", "s1", 1), /no source files/);
    assert.throws(() => featured.ownerSourcePage("s1", 1), /Built-in courses/);
  });
});

describe("source pages for the owner", () => {
  it("shows any page of any file, draft or published", async () => {
    for (const s of [await course({ draft: true }), await course()]) {
      assert.equal(s.ownerSourcePage("s2", 1).text, "Question 1. Why does a dry bed slow the clock?");
      assert.deepEqual(s.ownerSourcePage("s4", 1).source, { id: "s4", name: "project.md", pages: 1 });
      assert.throws(() => s.ownerSourcePage("s4", 2), /pages 1 to 1/);
      assert.throws(() => s.ownerSourcePage("s9", 1), /No source/);
    }
  });
});
