# Stream B: the tutor, voice, pictures and the mutation loop

**Owner:** a friend + their agent. **Goal:** a bar at the bottom of every lesson ("Ask Muse") where a learner
types or speaks what they're stuck on, and the page **changes for them**: a plainer explanation, a worked
example, a generated diagram, an interactive widget, a short storyboard, all grounded in the course's source
pages and fact-checked. What works for several learners is proposed to the whole course.

Read first, in this order: `CLAUDE.md` (project rules: they bind you), `docs/hackathon/PLAN.md` (§1 product,
§2 the Meta models and their endpoints, §3 pedagogy, §4 growth rules), `docs/hackathon/JOIN.md` (the contract, file
ownership, git protocol), then `docs/studio/notes-coach.md` (the study coach you build on) and `src/coach/*`.
Stream A (Radesh + Claude) works in parallel on sources, figures and the page viewer; you share only the contract in `JOIN.md` §2.

## Kickoff prompt for your agent

> You are building stream B of HyperLearn for the Meta Global AI Developer Hackathon. Read `CLAUDE.md`,
> `docs/hackathon/PLAN.md`, `docs/hackathon/JOIN.md`, and this file, then do the work items in order. Use
> your own git worktree on branch `hackathon/b-tutor` from `origin/main`. You may commit and push **this
> branch** after each finished item (this plan authorises that; do not push or merge anything else, and
> never touch `main`). Run `npm run typecheck && npm test` before every commit. Stay inside the files this
> plan says you own; log anything else you touch in `docs/hackathon/notes-B.md`. Update
> `docs/hackathon/status-B.md` after each item. Never read, print or commit `.dev.vars`, `.env`, or any key.
> If a spike result contradicts the plan, write down what you found and use the stated fallback.

## Kickoff

```
git fetch && git worktree add ../hyper-learn-b -b hackathon/b-tutor origin/main
cd ../hyper-learn-b && npm install
cp .env.example .env             # Node scripts and tests read .env
# .dev.vars is the Worker's local secrets file (gitignored; create it yourself). Put YOUR OWN Meta key in it:
#   MODEL_API_KEY=...   and, for local Meta calls, MODEL_BASE_URL=https://api.meta.ai/v1  REASONING_MODEL=muse-spark-1.3
# (Clerk sign-in values come from Radesh, or use the AUTH_DEV_BYPASS smoke-test route in CLAUDE.md.) Never commit either file.
```

Create the two contract files from `JOIN.md` §2 (exact contents) as the first commit, if they aren't there yet.
Run the app: `npm run dev:worker` (:8787) and `npm run dev` (:5173). To test studio features, create a course
in the UI and set your key in its Studio page.

## You own

`src/tutor/**`, `src/meta/image.ts`, `src/storage/tutor.ts`, `src/coach/**` (add only; existing exports keep
their behaviour and tests), `src/models.ts`, `web/src/components/{TutorDock,PersonalLayer,Storyboard}.tsx`,
`web/src/hooks/useVoice.ts`, `worker/voice.ts`, `web/src/styles/tutor.css`, `docs/hackathon/*-B.md`.
Hotspot edits go in the places listed in `JOIN.md` §3. You never edit `src/generate/**`, `src/course/**`, `web/src/files.ts`, `SourceViewer.tsx`, or the intervention templates (A owns them).

## You provide to stream A / the join (see `JOIN.md` §2)

`gen:` image refs and the `generatedImage(id)` callable; personal blocks that carry `provenance`; a tutor that
takes a `PageImages` (default `noPageImages`) so A's page images plug in; an `interact` tool that validates
with whatever `InterventionSchema` allows.

## You consume (already in the repo)

`CourseService`: `snapshot`, `citedSources`, `sourcePage` (page **text**), `beginRepair`/`continueRepair`,
`coachState`, `coachInsights`, `requestEdit`. `src/coach/diagnose.ts` (`drawDiagnostic`, `scoreDiagnostic`),
`src/coach/repair.ts` (`writeRepair`: the grounded, fact-checked personal-lesson writer), `src/generate/write.ts`
(`sectionFromDraft`, `sanitizeMarkdown`: **reuse them; don't write a second sanitiser**), `src/interventions/templates.ts`.

## Work items

### B0. Spikes: do the Meta endpoints behave? (2 h; nothing merges)

Script `scripts/spike-b.ts` (not shipped; never print the key), your own Meta key (and a Baseten key for S7). Write
`docs/hackathon/spike-B.md`: a table of try / result / decision. Facts and sources for each endpoint are in `PLAN.md` §2.

| # | Try | Pass means | Fallback |
| --- | --- | --- | --- |
| S4 | `muse-image-1.0` via `metaFetch` to `/v1/images/generations`: a 16:9 labelled diagram ("UMA vs NUMA: local and remote memory"); then an edit/refinement call | Readable labels; edit keeps the layout; note response shape (URL or base64) and latency | Skip generated diagrams; storyboard frames become code-rendered SVG |
| S5 | Voice: stream 5 s of 16 kHz mono 16-bit PCM to `wss://api.meta.ai/v1/asr/realtime` **from a Worker** (workerd), key server-side | A transcript returns; note the message format and how the end of speech is signalled | Browser `webkitSpeechRecognition`, and say so in the UI and the video |
| S6 | A Spark tool-calling loop with 3 tools, including two parallel calls in one turn | Correct tools and arguments; valid JSON | Fewer tools; `reasoning_effort: low`; sequential only |
| S7 | The same tutor prompt on `meta-models/muse-spark-open-1026` through Baseten (the guide says to use this id, not `muse-spark-open`) | Valid tool calls or structured output; latency acceptable | Open weights only for the writer and checker |
| S8 | Does the `agents` SDK support a streaming `@callable` (tokens reach the browser as produced)? | Yes, with a minimal example | Poll state every 700 ms while a turn runs |
| S9 | Cost and latency of one tutor turn and one personal mutation (tokens, seconds, dollars) | Turn: first token under 8 s. Mutation: under 60 s. A full demo run under about $5 | Lower `reasoning_effort`; cache; shorter context |

Decide and write down: streaming or polling (S8), the tool list (S6), the voice path (S5).

### B1. Tutor core (4 h)

- **What:** `CourseService.tutorTurn(learner, { lesson, section?, text, history? })` runs a bounded tool loop on
  Spark and returns `{ reply, actions: TutorAction[], blocks: PersonalBlockRef[] }`. The tools are code; the model
  only chooses among them.
- **Where:** `src/tutor/{tools,loop,prompt,types}.ts`; `src/storage/tutor.ts` (`hl_tutor_turns(learner, seq, role, text, at)`,
  index `(learner, lesson, seq)`); service methods **after `coachInsights`**; callable `tutorTurn` in
  `worker/course-agent.ts` after `coachInsights`; an agent entry `tutor` in `src/config/agents.json` (and its name in `src/agents.ts`).
- **Context (no vector search; the lesson fits in the model's 1M window):** the learner's lesson and sections, the
  section in view, what the learner just missed (from the last quiz result), and the cited pages' text. Never the answer key.
- **Tools** (each validates its arguments in code; none returns an answer key):

  | Tool | Effect |
  | --- | --- |
  | `read_section(id)`, `read_page(source, page)` | text from the learner's served release / cited files only |
  | `look_at_page(source, page)` | a `PageImages.get(...)` result sent to Spark vision; with `noPageImages` it says "no picture; here is the text" |
  | `go_to(lesson, section)`, `open_source(source, page)` | return a `TutorAction`; ids must exist on the learner's release |
  | `ask_me()` | a short diagnostic question first (B3) |
  | `rewrite_for_me(section, approach, note)` | a personal block (B3) |
  | `draw_it(prompt)` | a Muse Image diagram (B5) |
  | `interact(spec)` | one widget, validated by `InterventionSchema` |
  | `suggest_for_everyone(section, why)` | records a suggestion for editors (B6) |

- **Budgets:** at most 6 model calls per turn, 12 turns kept in the prompt (older ones summarised into one row, so
  the log grows with turns but the prompt does not), 40 turns kept per learner per lesson, **message ≤ 1,000
  characters**, a per-user daily quota (reuse the coach's quota pattern), a per-call timeout.
- **Rule:** the tutor asks a diagnostic question **before** explaining something the learner got wrong, and never
  gives away a quiz answer. This is a code-level rule: while a quiz attempt is open for the lesson, `rewrite_for_me` is
  refused for the items in it. (Pedagogy and its sources: `PLAN.md` §3.)
- **Done when:** with scripted fake models, tests cover: tool order, an unknown id refused, a call over budget
  stopped, the quota, the 12-turn window, that no tool result contains `"correct"`, and a model that tries to
  call a tool that doesn't exist. The turn works with `noPageImages`.

### B2. The dock (4 h) · needs B1 (use a fake service until it lands)

- **What:** a bar fixed at the bottom of the lesson: "Ask Muse" with a text box, a mic button (B4) and a "+"
  menu of shortcuts ("Explain differently", "Give me an example", "Quiz me on this"). Replies stream into a panel
  above the bar. `TutorAction`s are performed by the UI: `go_to_section` scrolls and highlights the section;
  `open_source` opens the source viewer (A's drawer; call the existing `openSource`).
- **Where:** `web/src/components/TutorDock.tsx`, `web/src/styles/tutor.css`; mounted once in `web/src/App.tsx`
  (learners only, only when the course is published and a model is available). Streaming per the S8 decision.
- **Done when:** the dock sends the lesson and the section in view; shows reply text as it arrives; "go to"
  works; it doesn't cover the quiz or the footer on a phone-width screen; the keyboard works (Enter sends, Escape
  closes); it shows "Muse is thinking" with the step names (reading the section, looking at page 16…) rather than a spinner.

### B3. Personal layer: "Made for you" blocks (4 h) · needs B1

- **What:** `rewrite_for_me` and `ask_me` produce **personal blocks**, shown **inside the page**, under the section
  they're for, marked "Made for you · undo". They never change the course for anyone else.
  - `ask_me`: a one-question diagnostic from the learner's lesson (`drawDiagnostic`), scored by `scoreDiagnostic`.
  - `rewrite_for_me(section, approach, note)`: calls `writeRepair` (the existing grounded writer + fact checker, 2–4
    calls) with the approach, the learner's words and their wrong answers; returns blocks plus a `Provenance`
    (`made_for`: "you picked 'fairly sure' on the NUMA answer"; pages; fact-check verdict).
- **Where:** `src/tutor/personal.ts`, `hl_personal_blocks(learner, section, id, approach, blocks JSON, provenance JSON, release, at)`
  with a unique `(learner, section)` for the live one (at most 1 live per section; older ones archived, not deleted),
  index `(learner, section)`. Callables `personalBlocks(section)` and `undoPersonal(id)`. UI: `PersonalLayer.tsx`
  rendered by a new `sectionFooter` prop in `LessonView` (one added prop and one use; A edits the other parts of that file).
  Render with a private `PersonalMarkdown` (wrapping `marked`) until the join swaps in A's `Markdown`.
- **Shared work:** when the learner gave no words, the result is cached per `(release, section, approach)` and
  served to everyone with the same need (the coach already does this: reuse `hl_shared_repairs`).
- **Quota:** the coach's existing 8 personal lessons per learner per day cover this too.
- **Done when:** a test (fake models) shows a rewrite appears only for its learner, undo removes it, a second
  rewrite replaces the first, an ungrounded draft (cites a page not on the section) is refused with "I couldn't
  ground that" instead of shown, and the shared cache is hit when no words were given.

### B4. Voice (3 h) · needs S5 · uses `worker/voice.ts`

- **What:** push-to-talk in the dock. The browser records 16 kHz mono 16-bit PCM and streams it to a Worker route;
  the Worker proxies it to Meta's realtime transcription socket (the key never reaches the browser); the transcript fills
  the text box; the learner presses send (never auto-send).
- **Where:** `web/src/hooks/useVoice.ts` (AudioWorklet or `MediaRecorder` + resample to 16 kHz), `worker/voice.ts`
  (route `/agents/voice`, auth like `worker/index.ts` `withIdentity`: **no anonymous socket**), one added line in
  `worker/index.ts`.
- **Limits:** 60 s per recording, one active recording per user, a per-user daily cap on audio minutes (cost at
  $0.18/hour is tiny, but bound it anyway), close the upstream socket on any error.
- **Fallback (S5 fails):** the browser's speech recognition, labelled "browser speech" in the UI.
- **Done when:** saying "I don't get why remote memory is slower" puts the words in the box within about a second of
  stopping; a socket without a valid token gets 401; the 61st second is refused; a test replaces the upstream with a fake.

### B5. Muse Image: diagrams and the storyboard (4 h) · needs S4

- **What:** `draw_it(prompt)` makes a labelled diagram for the section; `storyboard(section)` makes 4–6 frames,
  each with a caption and narration text, played by a small player (play/pause, next, narration through the
  browser's `speechSynthesis`; Meta has no text-to-speech). This is a **storyboard, not generated video**: the official Meta API has no video generation.
- **Where:** `src/meta/image.ts` (`metaFetch` to `/v1/images/generations`; size/format fixed by code), table
  `hl_generated_images(id, learner, prompt_hash, mime, bytes, at)` (id = short hash; ≤ 150 KB, re-encode if
  larger), callable `generatedImage(id)` (**only the learner who owns it**, or anyone for a shared cache hit), `web/src/components/Storyboard.tsx`.
  Images are referenced in blocks as `![caption](gen:<id>)` (see the contract).
- **Prompts are built by code** from the section's title and a short, sanitised description from the model; the model never sends raw instructions to the image endpoint; the prompt has a length cap and a fixed style prefix ("clean labelled educational diagram, white background").
- **Quota:** 10 generated images per learner per day, 2 per mutation; cached by prompt hash so identical requests are free.
- **Done when:** a test (fake image endpoint) shows the cap, the cache hit, ownership, and that an oversized image is rejected;
  the storyboard plays with and without audio; a failed image call leaves the text block intact.

### B6. The bandit, suggestions and promotion (3.5 h) · needs B3

- **What:** (a) **Choose the approach by outcomes:** among `refute`, `worked_example`, `smaller_steps`, pick by Thompson
  sampling over `hl_coach_targets` counts (fixed vs shown) per target and approach; with fewer than 5 samples, fall
  back to the existing order in `approachFor`. Code decides, not the model. (b) **`suggest_for_everyone`:** stores a
  suggestion (section, why, the learner's approach and result) into a table editors read through `coachInsights`.
  (c) **Promotion:** when an approach has fixed at least **3** learners on the same target (a constant, `PROMOTE_AFTER`),
  `coachInsights` shows "Promote to the course" with the evidence; an editor presses it and it calls the existing
  `requestEdit` (kind `tune`/`ask`) with the approach and text → validate → risk tier → trial → keep or revert.
- **Where:** `src/coach/bandit.ts`, `src/coach/promote.ts`, additions in `coachInsights`; `web/src/components/CoachInsights.tsx` gets a "Promote" button (a small edit; the file is yours under `src/coach`'s umbrella: log it in `notes-B.md`).
- **Done when:** a seeded test where one approach has fixed 8 of 10 and another 2 of 10 picks the first
  in most of 1,000 draws (assert > 70%) and still sometimes explores; with 3 fixes a proposal appears with its
  evidence, with 2 it doesn't; promotion goes through the existing harness (tier and trial are visible), and a
  learner can't call it (it needs `repair`).

### B7. Open-weights switch (2 h) · needs S7

- **What:** one setting makes the tutor, the writer and the fact checker run on `meta-models/muse-spark-open-1026`
  via Baseten (OpenAI-compatible) instead of Muse Spark 1.3. It's the **$10K "Best Build on Meta Open Weight Models"** bonus.
- **Where:** `src/models.ts` (per-agent model override, env `OPEN_WEIGHTS_BASE_URL`, `OPEN_WEIGHTS_API_KEY`,
  `OPEN_WEIGHTS_MODEL`), `worker/course-agent.ts` (read the course's setting), a toggle in the Studio model settings (`modelSettings`/`setModelKey` already pick a model from `MODEL_CHOICES`: add the open model as a choice and the base URL for it).
- **Rules:** the base URL still never comes from a user; owners choose only from `MODEL_CHOICES`; the key is stored sealed like any other.
- **Done when:** the tutor and a personal rewrite run on the open model in your workerd smoke; the model name is visible in the UI; tests cover the choice list and that an unknown model is refused. Record latency and failures in `notes-B.md`.

### B8. Wonder as an independent verifier (stretch, 1.5 h) · needs B3

- **What:** one extra call by `muse-wonder-1.0` (a different model family) that checks each personal block's claims
  against its cited page text; disagreement with the first fact check becomes `fact_check: "doubted"` in the provenance.
  Cost: $4 / $20 per million tokens, so only the final block, once.
- **Done when:** a fake verifier that disagrees changes the verdict and the UI shows the doubt; a failed call leaves the first verdict.

## Rules for this stream (from `CLAUDE.md`)

- Every `@callable` starts with `this.actor("learn")` (or the permission it needs); put new permissions in `src/app/access.ts` with tests.
- Personal data stays out of the broadcast state; learners never get answer keys or other learners' data.
- **Growth, per item:** each item above names what it grows with, who pays and what's shared. Keep to it.
- Every model, image and audio call has a timeout, a per-run budget and a per-user quota. Re-read state after every `await`; long work is idempotent and recovers after a restart (a half-written block is marked failed, never stuck).
- `src/` stays runtime-neutral; `web/` imports only types from `src/`.
- Smoke testing in workerd follows `CLAUDE.md` (the `--persist-to` + `--var AUTH_DEV_BYPASS:true` variant on a spare port; delete the scratch state; never set the bypass on the deployed Worker).
- Say honestly what a result shows (CLAUDE.md): a fixed learner in a test shows the harness works, not that teaching works.

## Hand-off (before the join)

`docs/hackathon/notes-B.md`: what was built, decisions, deviations, known gaps, a 60-second demo, and every file
touched outside your ownership list. Then follow `JOIN.md` §5.

## Estimate

B0 2 · B1 4 · B2 4 · B3 4 · B4 3 · B5 4 · B6 3.5 · B7 2 = **26.5 h**; B8 is +1.5 stretch.
