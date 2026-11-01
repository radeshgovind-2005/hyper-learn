# Stream B hand-off: the tutor, voice, pictures and the mutation loop

Branch `hackathon/b-tutor` from `origin/main`, built 2026-11-01. `npm run typecheck`, `npm test` (470 tests,
32 new) and `npm run build:web` pass. Smoke-tested in workerd (`wrangler dev --port 8799 --persist-to <scratch>
--var AUTH_DEV_BYPASS:true`) with a real Meta key on a studio course built by the real generator.

## What was built

| Item | What | Where |
| --- | --- | --- |
| B1 | `tutorTurn(learner, { lesson, section?, text, shortcut? })`: a bounded tool loop on Spark (6 model calls, 60 s each, low reasoning effort), 11 tools that check every id in code and never return an answer key, a 12-exchange window with older messages folded into one summary row (80 kept per learner and lesson), 60 turns a day, 1,000-character input | `src/tutor/{loop,tools,prompt,model,types}.ts`, `src/storage/tutor.ts`, service methods after `coachInsights`, streaming callable `tutorTurn` |
| B1 rules in code | (1) `rewrite_for_me` is refused until something shows what the learner is missing on that lesson (an answered `ask_me`, a failed quiz, a coach diagnosis), unless they pressed a shortcut; (2) a message that quotes one of the questions in the learner's next exam draw is answered without a model call ("that's on your quiz"); (3) a reply that contains the right answer to one of those questions is replaced; (4) `ask_me` never uses a question from that draw | `service.ts` (`tutorTurn`, `askLearner`), `src/tutor/personal.ts` (`quotesPending`, `answerGuard`) |
| B2 | "Ask Muse" dock: sticky at the bottom of the lesson column, text box that grows, mic, "+" shortcuts (Explain differently, Give me an example, Quiz me on this), a panel with the conversation, step names as they happen ("Reading page 2…"), streamed text, the diagnostic question card; Enter sends, Escape closes; performs `go_to_section` (scroll + highlight) and `open_source` | `web/src/components/TutorDock.tsx`, `web/src/styles/tutor.css`, mounted in `App.tsx` |
| B3 | Personal blocks under the section they're for, "Made for you · Undo": a rewrite (the coach's grounded writer and fact check, now aimed at one section), a diagram, a widget, a storyboard. One live block per learner, section and kind; older ones archived (last 5 kept). Provenance on each (pages, fact-check verdict, "made for you because you picked … / you said …"). Practice questions reach the browser without their answers (`answerPersonal` grades them). A rewrite without the learner's own words is shared per release, section and approach (`hl_shared_repairs`); the coach's 8 personal lessons a day cover these too | `src/tutor/personal.ts`, `web/src/components/PersonalLayer.tsx`, `LessonView`'s new `sectionFooter` prop |
| B4 | Push-to-talk: AudioWorklet → 16 kHz 16-bit PCM in 80 ms frames → `/agents/voice` (signed in, a member of the course, one recording at a time, 60 s each, 20 min a day, granted by the course object) → Meta's realtime socket with the key in the handshake. Transcript fills the box; never auto-sent. Falls back to the browser's speech recognition, labelled | `web/src/hooks/useVoice.ts`, `worker/voice.ts`, `src/tutor/voice.ts` (socket-agnostic relay) |
| B5 | `draw_it`: Muse Image with a prompt built by code (fixed style prefix, section title, the model's description stripped to plain text, length caps), cached by prompt hash, 10 a day per learner, refused above 400 KB. `storyboard`: 4–6 frames, at most 2 pictures, narrated by `speechSynthesis` | `src/meta/image.ts`, `src/tutor/storyboard.ts`, `web/src/components/Storyboard.tsx` |
| B6 | Thompson sampling over `hl_coach_targets` (shown/fixed per target and approach, kept current on write by coach re-checks and by the tutor's next question on a rewritten section; filled once from old coach events). Fewer than 5 samples: the fixed order. Suggestions for editors (`tutorSuggestions`). "Promote to the course" when one approach fixed ≥ 3 learners on a target: an owner edit (`tune`) through the existing edit harness | `src/coach/bandit.ts`, `src/coach/promote.ts`, `coachInsights` (`promote` field), `CoachInsights.tsx` |
| B7 | A base URL per model choice: `OPEN_WEIGHTS_BASE_URL` (+ optional `OPEN_WEIGHTS_MODEL`, default `meta-models/muse-spark-open-1026`) adds the open model to the owner's choices with its own endpoint. The owner's key for it is stored sealed like any other; the address is the Worker's, never the owner's | `src/models.ts`, `OwnerModelSettings.endpoints`, `worker/course-agent.ts` |
| B8 | Muse Wonder checks the final personal rewrite once (`TUTOR_VERIFIER=on`); a disagreement becomes `fact_check: "doubted"`; a failed call leaves the first verdict | `src/tutor/verify.ts` |

## Decisions and deviations from PLAN-B

- **Unique live block per (learner, section, kind)**, not per (learner, section): a rewrite and a diagram under
  the same section are both shown. A second rewrite replaces the first, as planned.
- **`rewrite_for_me(section, note)` has no `approach` argument.** Code picks the approach (the bandit, or the
  fixed order), or the dock's shortcut sets it ("Give me an example" → worked example). The plan says code
  decides; the model choosing it would contradict that.
- **Images are capped at 400 KB, not 150 KB.** Muse Image returns ~230 KB webp, ignores `size`, rejects
  `quality` and `output_compression` (spike S4), and workerd has no codec to re-encode. 400 KB base64 is
  ~540 KB, well inside the 2 MB row limit.
- **Promotion is an owner edit, not a trial.** It goes through `requestEdit` → validated proposal with a risk
  tier → an editor applies or discards it → undoable like any release. The existing edit path doesn't trial
  edits ("an edit isn't a measurable fix"), so neither does this.
- **Tutor activity is logged as coach events** (`tutor_ask`, `tutor_rewrite`, `tutor_outcome`), so the owner's
  insights and the learner timeline include it without a new event kind.
- **`interact` takes the widget spec as a JSON string** (validated with `InterventionSchema` and the leak
  checks), so the tool schema works whatever the API does with unions.
- **Low reasoning effort for tutor steps**: about 25% faster per step (B0), and the slow parts are tools.
- **Built-in courses**: the tutor runs there only with `TUTOR_FEATURED=on` (it would spend the Worker's key for
  every signed-in person), and never rewrites there (no owner writer).
- **A course on the open-weights model can't make pictures or use voice**: its key is for Baseten, and those
  are Meta endpoints. The tutor says so instead of failing silently.
- **Diagrams are not fact-checked**, and the UI says so under each one. In the smoke run a diagram added
  numbers (100 ns) the pages don't give.

## Measured (local workerd, Muse Spark, one learner each; shows the loop works, not that it teaches)

- A question turn ("I don't get why remote memory is slower"): **6 s**, 1 model call; Muse asked a diagnostic
  question first.
- After the answer: one turn of 2 model calls (**24 s**) scrolled to the section and started a rewrite, a diagram
  and a contrast widget in parallel. The rewrite was ready in **~30 s** (worked example, every block citing p.2,
  fact-checked), the diagram in about the same time.
- Before low reasoning effort, a similar turn took 54–75 s (6 calls, one refused widget).
- Voice through workerd: partial words while speaking; final transcript **206 ms after release**; no token → 401.
- Muse Wonder: 5–6 s per check; it passed a true claim and caught both errors in a false one.
- The course build itself (3 pages of original NUMA notes): 3.5 min, 3 lessons, 45 questions.

## Known gaps

- **S7 / B7 not run live**: no Baseten key here. Configuration and tests only; J9 needs a real run.
- **The UI was checked through a dev harness, not the real shell**: Clerk sign-in can't be done by an agent, so
  the dock, personal blocks, storyboard host and diagram were exercised on a page that renders the real
  `LessonView`, `TutorDock` and `PersonalLayer` against workerd with the dev bypass (desktop and 375 px). The
  `App.tsx` wiring compiles and builds but was not seen in a browser. The microphone path in a real browser is
  untested (the relay was tested with recorded speech through workerd).
- **The Promote button and suggestions list** (Studio → coach insights) were not seen in a browser; the
  service paths are tested.
- Personal blocks use a private `PersonalMarkdown` and a small provenance line until the join (J4b, J4c).
- Image pieces carry the image id; they don't put `![…](gen:…)` into Markdown, so the sanitiser change (J4d) is
  only needed if the writer is later allowed to place pictures inline.
- `pruneImages` matches ids with `LIKE` over live blocks; it runs at most once a day.
- The writer sometimes starts feedback with "Right", so the practice check reads "Right. Right — …".

## Files touched outside the ownership list

- `src/app/service.ts` (hotspot): imports; `tutor` field and constructor lines; `ServiceOptions.tutor` and
  `TutorOptions`; tutor methods after `coachInsights`; `OwnerModelSettings.endpoints` and its use in
  `ownerProvider`; `beginRepair` chooses a first try's approach by the bandit; `submitRecheck` counts the
  outcome; `coachInsights` adds `promote` and counts `tutor_outcome`; `deleteMyData` deletes tutor data.
- `worker/course-agent.ts` (hotspot): tutor options at construction; callables after `coachInsights`; RPC
  `voiceGrant` / `voiceDone`.
- `worker/index.ts`: one import and one line for `/agents/voice`.
- `web/src/App.tsx`: the dock before `</Shell>`'s children close; personal blocks and the dock's actions near
  `lessonId`; `stream` and `token` helpers next to `call`.
- `web/src/components/LessonView.tsx`: the `sectionFooter` prop and its one use.
- `web/src/types.ts`: the `// ─── stream B ───` block.
- `web/src/components/CoachInsights.tsx`: Promote button and suggestions.
- `src/agents.ts`, `src/config/agents.json`: agents `tutor` and `verifier`.
- `src/analytics/learner.ts`: timeline lines for tutor events.

## The 60-second demo

1. A learner opens a lesson of a published studio course; the "What are you stuck on?" bar sits under it.
2. Press the mic, say "I don't get why remote memory is slower", press it again: the words appear; press Send.
3. Muse puts one question in the panel first. Answer it (pick the "same speed" option).
4. The panel shows "Muse is thinking · Going to the section · Rewriting the section for you · Drawing a diagram";
   the page scrolls to the section.
5. Under it, "Made for you" blocks grow: a rewrite citing the page ("fact-checked ✓", "Made for you because you
   picked …"), a labelled diagram, a contrast card. Undo takes any of them down; nobody else sees them.
6. As the owner, Studio → what learners keep needing: "Promote to the course (3/4 fixed)" once enough learners
   were fixed by one approach; it becomes an edit proposal in the repair drawer.

## Running it

- Tests: `npm test`. Spikes: `npx tsx scripts/spike-b/spike-*.ts` (read `.env`, never print the key).
- Smoke: start `wrangler dev --port 8799 --persist-to <scratch> --var AUTH_DEV_BYPASS:true --var
  KEY_ENCRYPTION_SECRET:<random> [--var TUTOR_VERIFIER:on]`, then `npx tsx scripts/spike-b/smoke.ts setup`,
  `… tutor`, `… voice <16 kHz mono wav>`. Delete the scratch state afterwards.
