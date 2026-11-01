# JOIN: how the two streams work in parallel and become one product

Two people, two agents, two branches. **Stream A** (`PLAN-A.md`: Radesh + Claude) owns sources, sight and
the page. **Stream B** (`PLAN-B.md`: a friend + their agent) owns the tutor, voice, pictures and the
mutation loop. The streams share nothing but the contract in §2, so each can be finished, tested and
shipped without the other. This file says how they stay out of each other's way, and how they are joined.

Read `CLAUDE.md` and `PLAN.md` first. Their rules apply to both streams.

## 1. Principles

1. **Additive only.** Neither stream changes an existing function signature, table column, or exported
   type that the other might use. New callables, new tables (`CREATE TABLE IF NOT EXISTS`), new files.
2. **Independently shippable.** `main` + A must pass CI and make a better product on its own. So must
   `main` + B. If one stream isn't ready at the join gate, the other ships alone (§8).
3. **Fakes at the seam.** Where B needs something from A (page images) it codes against an interface with a
   do-nothing default. Where A's output shows up in B's UI (provenance, figures) A ships a component B uses
   at join time. No stream waits for the other.
4. **Code decides.** New server paths follow the CLAUDE.md rules: `this.actor(permission)` first, bounded
   input, per-call timeouts, per-user quotas, tests with scripted fake models. Live-API code is covered by
   a spike script and by tests that replace the network.
5. **Only the integrator deploys.** A push to `main` deploys to the live site, so only Radesh merges to
   `main`. Everyone else pushes branches and opens **draft PRs** (CI runs on PRs, with no deploy).

## 2. The contract

Both streams create these two files **with exactly these contents** (the first to need one creates it;
because the bytes are identical, git merges the two additions without a conflict). After that, neither
edits them without telling the other in `status-*.md`.

### `src/media/contracts.ts`

```ts
import type { Citation } from "../course/schema.js";

/** One rendered page of an uploaded file. */
export interface PageImage {
  mime: "image/png" | "image/jpeg";
  base64: string;
}

/**
 * Where the tutor gets a source page as a picture. Stream A implements it (the pages it stored in the
 * build); until the join the tutor runs on `noPageImages` and falls back to the page's text.
 */
export interface PageImages {
  get(sourceId: string, page: number): Promise<PageImage | null>;
}
export const noPageImages: PageImages = { get: async () => null };

/**
 * Pictures inside lesson Markdown are written `![caption](fig:s1/p15/f1)` (a figure cropped from a source
 * page; stream A) or `![caption](gen:3fa9c1d2)` (an image generated for one learner; stream B). Anything
 * else is dropped to its alt text, as the sanitiser does today.
 */
export const ASSET_REF = /^(fig|gen):[a-z0-9][a-z0-9/_-]{0,79}$/;
export type AssetKind = "fig" | "gen";

export function parseAssetRef(src: string): { kind: AssetKind; id: string } | null {
  const match = /^(fig|gen):(.+)$/.exec(src);
  return match && ASSET_REF.test(src) ? { kind: match[1] as AssetKind, id: match[2]! } : null;
}

/** Why a block is on the page. Stream A draws the chip; stream B fills it in for personal blocks. */
export interface Provenance {
  pages: Citation[];
  fact_check: "supported" | "doubted" | "unchecked";
  /** "Made for you because…": only on personal blocks. */
  made_for?: string;
}

/** What the tutor asks the page to do. The browser performs it; the server only names it. */
export type TutorAction =
  | { kind: "go_to_section"; lesson: string; section: string }
  | { kind: "open_source"; source: string; page: number };
```

### `src/meta/client.ts`

```ts
export interface MetaClientConfig {
  baseURL: string;
  apiKey: string;
  /** Per attempt. Default 60 s. */
  timeoutMs?: number;
  /** Retries after the first attempt, for network errors, 408, 409, 429 and 5xx. Default 2. */
  retries?: number;
}

const RETRYABLE = new Set([408, 409, 429]);

/** A fetch to Meta's API with a timeout and bounded retries. The key goes in the header and nowhere else. */
export async function metaFetch(config: MetaClientConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const { timeoutMs = 60_000, retries = 2 } = config;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${config.apiKey}`);
  if (!headers.has("content-type") && typeof init.body === "string") headers.set("content-type", "application/json");
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${config.baseURL.replace(/\/$/, "")}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || attempt >= retries || !(RETRYABLE.has(res.status) || res.status >= 500)) return res;
    } catch (error) {
      if (attempt >= retries) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 3 ** attempt));
  }
}
```

Streams use it for the endpoints that LangChain doesn't cover: A for `sam-3.1`, B for `muse-image-1.0`
and the voice socket. Neither puts a key in a log, a state broadcast or a browser.

### The seams, in words

| Seam | Provider | Consumer | Before the join |
| --- | --- | --- | --- |
| Page as a picture: `PageImages` | A: `CourseService.pageImages(learner)` returns one that serves only the files the learner's release cites | B: the tutor's `look_at_page` tool | B uses `noPageImages` |
| Figures in Markdown: `fig:` refs | A: sanitiser keeps them, the builder creates them, callable `figure(id)` serves them, `Markdown.tsx` renders them | B: personal blocks may contain them (the writer is shared) | B never sees one |
| Generated images: `gen:` refs | B: tutor creates them, callable `generatedImage(id)` serves them | A's `Markdown.tsx` renders both kinds and calls the right callable | A renders `fig:` only |
| Provenance chip: `Provenance` | A: `ProvenanceChip.tsx`, filled for built blocks | B: fills `provenance` on personal blocks | B shows its own small label |
| Interactive templates: `InterventionSchema` | A: adds `explorer` and `compare` | B: the `interact` tool validates with whatever the schema allows | B supports the three existing templates |
| Rendering Markdown | A: `web/src/components/Markdown.tsx` (`marked` + KaTeX + asset images) | B: renders personal blocks with it | B uses a private `PersonalMarkdown` wrapping `marked` |
| Existing course methods (`snapshot`, `citedSources`, `sourcePage`, `beginRepair`, `drawDiagnostic`) | exist today | B reads them | unchanged by A; A only adds |

## 3. Who owns which file

"Owns" means the only stream that edits it. A file nobody lists is shared and needs a note in `status-*.md`
before editing.

| Stream A owns | Stream B owns |
| --- | --- |
| `web/src/files.ts`, `web/src/passage.ts` | `src/tutor/**` (new) |
| `web/src/components/SourceViewer.tsx` | `src/meta/image.ts` (new) |
| `web/src/components/Markdown.tsx`, `AssetImage.tsx`, `ProvenanceChip.tsx` (new) | `src/storage/tutor.ts` (new) |
| `web/src/components/Interventions.tsx` | `src/coach/**` (adds only; existing exports keep their behaviour) |
| `src/course/compile.ts`, `src/course/sources.ts`, `src/course/assets.ts` (new) | `src/models.ts` |
| `src/generate/**` | `web/src/components/TutorDock.tsx`, `PersonalLayer.tsx`, `Storyboard.tsx` (new) |
| `src/interventions/templates.ts` and `checks.ts` | `web/src/hooks/useVoice.ts` (new) |
| `src/storage/media.ts` (new) | `worker/voice.ts` (new) |
| `src/meta/sam.ts`, `src/meta/vision.ts` (new) | `web/src/styles/tutor.css` (new) |
| `web/src/styles/viewer.css` (new) | `docs/hackathon/notes-B.md`, `status-B.md` |
| `docs/hackathon/notes-A.md`, `status-A.md` | |

**Hotspots both streams must touch**, with where each makes its edit so the diffs don't collide:

| File | Stream A edits here | Stream B edits here |
| --- | --- | --- |
| `src/app/service.ts` | imports; one field + constructor line for `media`; methods **directly after `sourcePage`** (≈ line 1761) | imports; one field + constructor line for `tutor`; methods **directly after `coachInsights`** (≈ line 1115) |
| `worker/course-agent.ts` | callables **directly after `sourcePage`** (≈ line 520) | callables **directly after `coachInsights`** (≈ line 388); the voice route lives in `worker/voice.ts` and `worker/index.ts` gets one added line |
| `web/src/types.ts` | a block headed `// ─── stream A ───` at the end | a block headed `// ─── stream B ───` at the end |
| `web/src/App.tsx` | hash handling near the `lessonId` logic | mounting `<TutorDock>` just before `</Shell>`'s children close |
| `web/src/components/LessonView.tsx` | `BlockView` and the Markdown helper at the top | one new prop `sectionFooter` and its use under each section's blocks |
| `package.json`, `package-lock.json` | `katex` (A5) | none planned |
| `src/agents.ts`, `src/config/agents.json` | new agents `figure_reader` | new agents `tutor`, `verifier` |

Each stream keeps its own CSS in its own file under `web/src/styles/` and imports it from its own components.
`web/src/styles.css` is not edited by either stream.

## 4. Git protocol

- **Base: `origin/main`.** Your local `studio/edits` is two merge commits behind it. Run `git fetch && git switch -c hackathon/a-sources origin/main` (or `…/b-tutor`).
- Use a **git worktree** per stream so agents never share a working directory:
  `git worktree add ../hyper-learn-b hackathon/b-tutor`.
- **One commit per finished work item**, message `feat(a7): …` / `feat(b3): …`, with the repository's attribution
  lines. Run `npm run typecheck && npm test` before each commit. (`CLAUDE.md` says to commit only when asked:
  tell your agent explicitly that it may commit and push **its own branch** under this plan.)
- Push the branch after each item; open a **draft PR to `main`** so CI runs. Nobody merges to `main` except Radesh, at the join.
- Never commit `.dev.vars`, `.env`, `.admin-token`, or any key. Each person uses their **own** Meta key (credits are claimed per person), stored in their own `.dev.vars`.
- After each item, update your `docs/hackathon/status-<A|B>.md` (one line per item: `todo | doing | done | cut`, the commit, anything the other stream can now use). The other stream reads it instead of asking.
- Rebase on `origin/main` only if `main` moves (it shouldn't). Don't rebase onto each other's branches.

## 5. A stream is "ready to join" when

- [ ] Every non-stretch item in its plan is `done` or explicitly `cut` (with the reason in `status-*.md`).
- [ ] `npm run typecheck`, `npm test` and `npm run build:web` pass on the branch.
- [ ] Its **hand-off note** exists (`notes-A.md` / `notes-B.md`): what was built, decisions, deviations from the plan, known gaps, how to demo it in 60 seconds, and every file touched outside its ownership list.
- [ ] It runs in workerd (CLAUDE.md "Smoke testing in workerd", the `--persist-to` variant) with a studio course and a real key, and the 60-second demo works.
- [ ] No secret in the diff (`git diff origin/main | grep -iE "sk-|api[_-]?key|bearer "` finds only variable names).
- [ ] It degrades without the other stream (§8): nothing throws when `PageImages` is the empty default, or when no `fig:`/`gen:` image exists.

**Join starts when both are ready, or at Nov 3 18:00 ET, whichever is first.** Whatever isn't ready then is cut.

## 6. The join, step by step

Owner: Radesh with Claude unless noted. Time-boxes are for the whole step. Stop at a step that fails its check
and use its fallback instead of pushing on.

| # | Step | Check | Time | If it fails |
| --- | --- | --- | --- | --- |
| J1 | `git switch -c hackathon/integration origin/main`; merge **A** first (it changes the build pipeline and schemas); then `npm install`, `typecheck`, `test` | green | 30 min | Fix on the branch; A is the base of everything |
| J2 | Merge **B**. Resolve the hotspots by the table in §3. Regenerate `package-lock.json` from `main`'s version with `npm install` (never hand-merge a lockfile) | green | 45 min | Hotspot conflicts are expected, and each is a few lines |
| J3 | Delete duplicates: one `src/meta/client.ts`, one `src/media/contracts.ts` (they are identical, so likely nothing to do) | no duplicate helpers | 15 min | |
| J4 | **Wire the seams**: (a) construct the tutor with `service.pageImages(learner)` instead of `noPageImages`; (b) switch B's `PersonalMarkdown` to A's `Markdown`; (c) have B's personal blocks carry `provenance` and render `ProvenanceChip`; (d) let the sanitiser accept `gen:` refs that B created (a checker passed in by the tutor); (e) register A's `explorer` and `compare` in B's `interact` tool; (f) add `figure` and `generatedImage` to the access matrix for `learn` | each seam has a test (J5) | 90 min | A seam that can't be wired in time stays at its "before the join" behaviour (§2 table) |
| J5 | Write `src/app/join.test.ts` with scripted fake models: (1) `look_at_page` returns a stored page image to the model; (2) `rewrite_for_me` on a section whose pages have figures produces a block with a `fig:` ref that resolves; (3) a `gen:` image shows up in a block and is served only to its learner; (4) `interact` accepts an `explorer` spec and refuses a malformed one; (5) a learner cannot fetch a figure from a source their release doesn't cite; (6) the dock's answer carries no answer key | all six pass | 60 min | Fix the seam, not the test |
| J6 | **Smoke in workerd** per CLAUDE.md (spare port, `--persist-to` scratch dir, `AUTH_DEV_BYPASS` on the command line only). Run the **acceptance script** in §7 with a real key. Delete the scratch state afterwards | the script passes | 60 min | Note exactly which step failed; fix; rerun the script from the top |
| J7 | Open the PR `hackathon/integration` → `main`. CI green. Merge; the deploy runs. Verify the live site: sign in, open a course, the acceptance script's first four steps | live matches local | 30 min | Revert the merge commit (a revert deploys the old build); keep working on the branch |
| J8 | **Rebuild the demo course on the new pipeline** (A11's licensed material). Old courses need their PDFs re-uploaded once to get the original file, page images and figures | figures and the real page viewer appear on the live site | 45 min | Keep the old course as the fallback demo, and say in the video that it was built before the upgrade |
| J9 | **Open-weights run**: the whole acceptance script with `muse-spark-open-1026` on Baseten (B7's flag). Record latency and any step that fails | one full pass, or a written list of what doesn't work | 45 min | Claim the bonus only for the parts that pass |
| J10 | **Pilot**: 5–10 people, 15 minutes each, on the live demo course. Radesh runs it; collect the numbers from `coachInsights` and "My progress"; ask each for one sentence | n and results written into `docs/hackathon/pilot.md` | 2 h, in parallel with J11 | A smaller n, reported as it is |
| J11 | **README front page** (screenshot, one sentence, loop diagram, video link, "what was built during the hackathon" with dates, the §7 checklist from `PLAN.md` ticked with links, how to run). Move the architecture below the fold | a stranger understands it in 60 s | 2 h | |
| J12 | **Record the video** from the beat sheet in `PLAN.md` §6, twice, cut once, subtitles on. Post it on X for the Viral prize. **Submit** (video link opens logged out, repo public, everyone listed). Claim credits if not yet claimed | submission page shows "submitted" | 3 h | Submit the best take at 18:00 ET; don't wait for a perfect one |

Joint review before J7: both people read the diff of the other stream once (15 minutes each). Reading is
faster than debugging.

## 7. The acceptance script (the demo path, end to end)

This is J6's check, J9's check and the video's storyboard. Each line names what it proves.

1. Owner uploads a PDF in a new studio course; the build log shows the "see" stage (A7). *Meta tooling: vision, SAM*
2. The built lesson shows a real figure and a real table, and equations render (A5, A7). *Technical, demo*
3. Click a reference chip: the **original page** opens with the cited lines in yellow (A2, A3). *Grounded*
4. Open the course URL with a `#lesson/section` hash: it lands on the section (A4).
5. A learner presses the mic and says "I don't get why remote memory is slower" (B4). *Voice Transcribe*
6. The dock asks one diagnostic question first, and the learner answers (B3). *Pedagogy*
7. The dock goes to the right section and rewrites it for this learner: plainer text, the cropped figure, a Muse Image diagram, an `explorer` slider widget (B1–B5, A9, J4). *Spark, Image, widgets*
8. The new block says "Made for you" with a provenance chip: pages, "fact-checked ✓" (A8, B3). *Grounding made visible*
9. Re-check passes. Two more learners get fixed by the same approach (B6). *The bandit*
10. An editor sees "Promote to the course", approves, the harness trials it and keeps or reverts it (B6, existing harness). *Agentic, closed loop*
11. The whole flow again with the open-weights toggle on (B7). *Open-weights bonus*
12. Devtools: no answer key in the learner's snapshot (A6). *Integrity*

## 8. If a stream isn't ready

| What ships | What the product is | What the video can't show |
| --- | --- | --- |
| **A alone** | Real page viewer, deep links, real figures and tables, safe assessments, widgets inside the course | The tutor, voice, "made for you", generated images. Fall back to the existing study coach as the "mutation" story, and be honest that it is text-only |
| **B alone** | The dock, voice, personal blocks, generated images, the bandit and promotion, on text-only courses with the old text viewer | Real pages and figures, SAM, the answer-key fix. Fix the answer-key leak by itself in a 30-minute patch before shipping |
| **Both, one seam unwired** | Each feature works; two don't meet (for example the tutor can't *look at* a page) | That one beat. Cut it from the script |

## 9. Cut list, in order

Same as `PLAN.md` §8. Within a stream, cut from the bottom of its list upwards: A10, then A9; B8, then B5's
storyboard, then B4. **Never cut** A2, A3, A7 (A), B1, B2, B3 (B), and J7–J12.

## 10. Team and submission housekeeping

- The hackathon allows teams of up to four. **List your friend on the submission** ("everyone who worked on
  the project"), and appoint one Representative (Radesh) who submits.
- **Each person claims their own $150 Meta credits** by Nov 4, 21:00 ET; credits can't be claimed for someone else. Each also requests Baseten and Modal credits separately.
- Each person's agent needs that person's key in their own `.dev.vars`. The **deployed** Worker uses Radesh's
  key (a studio course uses its owner's key, entered in the UI). Don't share keys in chat or in a commit.
- Everything in the demo must be code and material the team has rights to (A11).
