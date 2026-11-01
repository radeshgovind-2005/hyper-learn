# HyperLearn: hackathon finish plan (deadline Nov 4, 9 PM ET)

Written 2026-11-01. Supersedes nothing in `docs/studio/PLAN.md`; this is the last-mile plan.
Read `CLAUDE.md` first: every rule there still applies (boundaries, "agents propose, code decides",
and the three growth questions for anything new).

## 1. The product in one line

**A lesson that mutates around you.** You say what you're stuck on, in text or by voice. The coach
diagnoses, goes back to the missing idea if needed, and rewrites *your* page: a plainer explanation,
a worked example, the original figure, a generated diagram, an interactive widget, a narrated
storyboard. Every mutation is grounded in the source pages, fact-checked, and measured. A mutation
that keeps working is proposed to the whole course, where the release harness trials it and keeps or
reverts it.

Why this and not "an AI tutor": the hackathon guide lists "simple AI for Education chatbots" and
"Basic RAG applications" as anti-projects. The tutor bar is only the *input device*. The product is
the closed loop behind it: **personal mutation → measured → promoted → trialled → kept or reverted.**
No other education entry will have the last three steps.

## 2. What the Meta stack gives us (verified, with confidence)

Checked 2026-11-01. "Official" = Meta's own pages; "gateway" = a third party documenting Meta's API.
**Anything marked gateway must pass its spike (A1 or B0) before we build on it.**

| Model | Id | What it does for us | Source | Confidence |
| --- | --- | --- | --- | --- |
| Muse Spark 1.3 | `muse-spark-1.3` | Text, image, video, **PDF** in; tools (parallel), structured output, 1M context, `reasoning_effort`, built-in `web_search`. $1.25 in / $4.25 out per M tokens | [Meta blog](https://dev.meta.ai/resources/blog/build-with-muse-spark/), [AI/ML API](https://docs.aimlapi.com/api-references/text-models-llm/meta/muse-spark-1.3) | official + gateway |
| Muse Wonder | `muse-wonder-1.0` | Frontier reasoning, same inputs, **text out only**. $4 / $20 per M. Use as the independent verifier, not as a generator of media | [VentureBeat](https://venturebeat.com/technology/metas-new-muse-wonder-and-muse-wonder-full-models-achieve-frontier-performance-but-only-the-weaker-one-is-available-via-api), [OpenRouter](https://openrouter.ai/meta/muse-wonder) | secondary |
| Muse Image | `muse-image-1.0` | Generate and **edit** images, multi-turn refinement, renders text/plots accurately. `POST /v1/images/generations`, $0.01 per image | [AI/ML API](https://docs.aimlapi.com/api-references/image-models/meta/muse-image), [OrcaRouter](https://www.orcarouter.ai/blog/muse-image) | gateway |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` | Streaming speech to text. `wss://api.meta.ai/v1/asr/realtime`, mono 16-bit PCM at 16 or 24 kHz, up to 10 min. $0.18/hour | [Pipecat](https://docs.pipecat.ai/api-reference/server/services/stt/meta), [The New Stack](https://thenewstack.io/meta-muse-voice-transcribe/) | gateway |
| SAM 3.1 | `sam-3.1` | Text-prompted segmentation of an image: boxes and pixel masks. `POST /v1/responses` | [example repo](https://github.com/anthonynolan/sam3), [LearnOpenCV](https://learnopencv.com/sam-3-whats-new/) | gateway |
| Muse Spark Open / Glimmer | `meta-models/muse-spark-open-1026` (Baseten) | Open weights: the **$10K bonus** and the "runs on open weights" story | hackathon guide | official |

**What Meta's API does not have: video generation.** Every source I found says the Muse video model is
only on third-party APIs. So we do not promise generated video. We build a **narrated storyboard
player** (Muse Image frames + captions + the browser's `speechSynthesis`), which the learner sees as a
short explainer. Say "storyboard" in the demo, not "video", unless the Day-0 spike proves otherwise.
There is also no Meta text-to-speech; narration is the browser's.

**The one fact that changes the plan:** Spark reads PDFs and images natively. Our pipeline throws away
every figure because it only extracts text (`web/src/files.ts`). We stop doing that.

## 3. Pedagogy and AI-engineering: adopt / stretch / skip

Per your standing request: what I considered, with sources.

| Option | Decision | Why |
| --- | --- | --- |
| Text + diagram together (multimedia principle) | **Adopt** | Mayer's 2024 meta-analysis (92 articles, 181 studies) finds text + diagrams the most reliable combination across factual, inferential and transfer outcomes, g = 0.37 ([Frontiers 2024](https://frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2024.1428732/pdf), [Hendrick summary](https://carlhendrick.substack.com/p/which-multimedia-strategies-actually)). Our lessons have none. |
| Refutation text for misconceptions | **Already built** | Keep; it's in `src/coach/repair.ts`. |
| Worked examples, then smaller steps | **Already built** | The three approaches already exist. Add the *choice between them by data* (below). |
| A tutor that scaffolds instead of answering | **Adopt as a rule** | The Harvard RCT (194 students, learning gains over 2× active learning) used a tutor built around the unit's objectives and feedback structure, and it did not do the thinking for the student ([Scientific Reports 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12179260/), [Harvard Gazette](https://news.harvard.edu/gazette/story/2024/09/professor-tailored-ai-tutor-to-physics-course-engagement-doubled/)). Our tutor asks a diagnostic question before it explains. |
| Choosing the approach per learner by outcomes (bandit) | **Adopt, small** | `hl_coach_targets` already counts, per target and approach, who was fixed. Pick the approach by Thompson sampling over those counts. About 40 lines, and code decides. It is a real "self-improving" claim we can show. |
| Vector RAG over the course | **Skip** | The whole lesson and its cited pages fit in Spark's 1M context. Embeddings add infrastructure and make us look like the banned "basic RAG". Retrieval is graph-based (section → cited pages) and already exists. |
| Wonder as independent verifier | **Stretch** | A second model family checking the writer's claims reduces correlated errors. Cheap: one extra call per mutation. Do it if B is ahead of schedule (B8). |
| Spaced repetition | **Skip** | Real value, no demo value in 3 days. |
| New question types | **Skip** | There are nine already. |
| More scaling work | **Skip** | See `docs/engineering/scaling-audit.md`: only fix what we touch. |

## 4. Rules for the new work (the three CLAUDE.md questions)

| New thing | Grows with | When and who pays | Shared? |
| --- | --- | --- | --- |
| Original PDF bytes | per file (cap: 25 MB/file, 100 MB/course) | once, at upload, in 512 KB rows | read by every learner |
| Page images and figure crops | per figure-bearing page (cap: 3 per page, 300 per course, ≤ 150 KB each) | once, in the build, background | read by every learner |
| Tutor messages | per learner per lesson (cap: 40 turns kept; older summarised into one row) | on write | no, personal |
| Personal mutations | per learner per section (cap: 1 live per section, 5 per day, existing coach quota) | background; cached per release + target + approach when the learner gave no words | **shared when no personal words**, as the coach already does |
| Generated images | per mutation (cap: 2 per mutation, 10 per learner per day, owner's key pays) | background | cached by prompt hash |
| Voice | per request (cap: 60 s of audio) | live, through the Worker; the key never reaches the browser | no |
| Model calls | per-run budget (tutor turn: 6 calls; mutation: 8) and per-user daily quota; every call has a timeout | | |

Broadcast state still holds summaries only. Learners never receive answer keys (fixed in P0.5).

## 5. Who does what

The work is split by **workstream**, not by day, so two people (each with an agent) can work at once.

- **`PLAN-A.md`: Sources, sight and the page** (Radesh + Claude). The original PDF, the real page viewer, deep
  links, tables and equations, figures read by Spark vision and cropped by SAM 3.1, assessment integrity,
  interactive widgets, the demo course.
- **`PLAN-B.md`: Tutor, voice, pictures and the mutation loop** (a friend + their agent). The dock, the tool
  loop, personal "made for you" blocks, voice, Muse Image, the bandit and promotion, the open-weights flag.
- **`JOIN.md`**: the shared contract, file ownership, git protocol, and exactly how the two are joined,
  tested, deployed and turned into the demo.

Where this document's earlier ids went:

| Earlier id | Now |
| --- | --- |
| S1–S3 | A1 |
| S4–S9 | B0 |
| P0.1 original file | A2 |
| P0.2 page viewer | A3 |
| P0.3 deep links | A4 |
| P0.4 extraction damage | A5 |
| P0.5 assessment integrity | A6 |
| P1.1 "see" step | A7 |
| P1.2 provenance | A8 (chip), B3 (personal blocks fill it) |
| P1.3 dock | B1, B2, B3 |
| P1.4 widgets | A9 |
| P1.5 voice | B4 |
| (generated images, storyboard) | B5 |
| P1.6 bandit and promotion | B6 |
| P2.1 open weights | B7 |
| P2.2 pilot, P2.4 README, P2.5 video | JOIN.md |
| P2.3 demo course on licensed material | A11 |

Only the deadline is calendar-bound: the join starts **Nov 3, 18:00 ET at the latest**, the freeze is
**Nov 4, 12:00 ET**, and submission goes in by **18:00 ET** (the deadline is 21:00).

## 6. The 3-minute video: beat sheet

| Time | Beat | Proves |
| --- | --- | --- |
| 0:00–0:15 | A learner opens a lecture-based course. "Everyone's course is the same. Mine should change when I'm stuck." | Impact: the problem |
| 0:15–0:40 | Drop in a PDF. Build log: Spark reads pages and figures, SAM 3.1 crops them, the course appears with the *real* slides and tables | Meta tooling: multimodal; Technical |
| 0:40–1:00 | Click a reference chip: the original page opens with the source lines highlighted | Grounded; fixes today's text-only viewer |
| 1:00–1:35 | Voice: "I don't get why NUMA is slower." Transcript appears (Voice Transcribe). The tutor asks one diagnostic question first | Meta tooling; pedagogy |
| 1:35–2:10 | The page mutates: a plain explanation with the cropped figure, a Muse Image diagram, a slider widget. Provenance chip: "p.16 · fact-checked · made for you" | Demo: the wow moment; Creative |
| 2:10–2:30 | Re-check passes. "Eleven learners fixed by this approach." Promote → trial → harness keeps it (or reverts a bad one, shown) | Agentic; the closed loop |
| 2:30–2:50 | Toggle "Open weights (Spark Open, Baseten)". Same flow runs | Open-weights bonus |
| 2:50–3:00 | "Real pilot, n = 8. Agents propose; code decides." Repo and URL | Honest impact |

## 7. Checklist against what the judges score

Tick each box with a link to the evidence (file, test, or video timestamp) before submitting.

**Stage 1: pass/fail**
- [ ] Fits a problem statement: **Build for Your World** (a problem you know firsthand: studying from lecture PDFs)
- [ ] Uses Meta's models, in the demo and the code
- [ ] Built during the event, with a dated "what's new" section (history starts 2026-10-28 ✓)
- [ ] Repository public ✓ (`radeshgovind-2005/hyper-learn`), LICENSE ✓
- [ ] Not an anti-project: not a chatbot over documents; the tutor writes grounded mutations that are measured
- [ ] No assets without rights (P2.3)

**Impact (30%)**
- [ ] A named user and a concrete pain, in the first 15 s of the video
- [ ] A real pilot, honestly reported (P2.2)
- [ ] Works on any student's own lecture PDFs (the Studio already does)
- [ ] Owner dashboard: "what learners keep needing repaired" (exists: `coachInsights`)

**Use of Meta AI tooling (25%): the 5-model table**
- [ ] **Muse Spark 1.3**: tutor tool loop, writer, examiner, vision on pages, structured output
- [ ] **Muse Wonder 1.0**: independent verifier of every mutation *(stretch)*
- [ ] **Muse Image 1.0**: diagrams and storyboard frames
- [ ] **Muse Voice Transcribe 1.0**: push-to-talk through a Worker proxy
- [ ] **SAM 3.1**: figure and table crops from page images
- [ ] **Muse Spark Open** on Baseten: the whole loop behind one flag
- [ ] A slide or README table naming each model, what it does and where in the code
- [ ] Something "that surprised even us": the lesson changes itself, grounded in the original page

**Technical depth and execution (20%)**
- [ ] Guarantees in code, not prompts: risk tier, autopilot ceiling, keep-or-revert, figure and citation validation
- [ ] 440+ tests pass; new tests for P0.1, P0.3, P0.5, P1.1 (figure ids), P1.6
- [ ] Per-call timeouts, quotas, bounded model-call budgets on every new path
- [ ] A one-page diagram of the loop

**Demo (25%)**
- [ ] Works live on the deployed URL; a pre-built demo course so nothing waits on a 5-minute build
- [ ] Every step visible: a streaming dock, build log, visible provenance
- [ ] A fallback recording if the network fails
- [ ] Video under 3:00, subtitles on, sound optional

**Bonus prizes**
- [ ] **Best Build on Meta Open Weight Models ($10K):** P2.1
- [ ] **Best Agentic Use-Case ($5K):** the tool loop plus the harness; autonomy bounded and explained
- [ ] **Best Creative Build ($5K, Muse Image or Muse Wonder):** generated diagrams, storyboards
- [ ] **Most Viral ($20K):** post the video on X by Nov 4, submit the link (engagement counts until Nov 8)
- [ ] **Community Vote ($10K):** share the gallery link

**Logistics**
- [ ] Claim your $150 Meta credits by Nov 4, 9 PM ET (each person claims their own)
- [ ] Request Baseten ($100) and Modal ($100) credits
- [ ] Everyone who worked on it listed on the submission page
- [ ] Video link opens logged out

## 8. Cut list, if time runs short

Cut in this order, and never cut an earlier row for a later one:
1. Wonder verifier, `storyboard`, `compare` widget.
2. Voice (fallback: browser speech recognition, and say so).
3. Generated diagrams (fallback: SAM crops only).
4. Promotion loop UI (keep the test and a manual script).
5. Never cut: P0.1–P0.5, P1.1, P1.3, P2.3–P2.5. They are the demo.

## 9. Risks

- **API shapes come partly from gateways.** The spikes (A1, B0) settle it; no feature starts before its spike passes.
- **Latency.** The coach's personal lesson took about 63 s locally. Stream tutor tokens; show the
  mutation's progress as steps; pre-warm the demo's mutation cache.
- **Cost.** About $1.25/$4.25 per M tokens on Spark and $0.01 per image: a full demo run should be a few
  dollars, but S9 measures it before we rely on it.
- **Extraction noise** is the source of the odd tables and fused lists; P1.1 (vision) is the real fix,
  P0.4 is the quick one.
- **Scope.** This is about 55 hours of work, split across two people and two agents. §8 is the pressure valve; take it
  early, not on Nov 4.
