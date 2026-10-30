# Owner edits (wave 2 D, first part)

Owners change a built course without rebuilding it. One engine, three ways in:

```
 "✎ Tune this section"     "Ask for a change"        "Add to the course"
 (preset and/or words)     (studio, repair drawer)   (a file the course doesn't cite yet)
          │                         │                          │ digest the new file
          └────────────┬────────────┘                          │
                       ▼                                       ▼
        tune: one rewrite             Course Editor agent → edit list (ids, pages, instructions)
                       │                code checks ids/pages; one retry; then keeps the valid part
                       ▼
        writer / examiner (the build's agents and checks) → validate each part on the course
        (a part that breaks it is dropped with a warning) → fact check new and rewritten sections
                       ▼
        proposal: changes + before/after + doubts ──► owner: Apply │ Discard
                       ▼
        draft: applied in place (draft revision must match) │ published: new live release 1.x
```

## Where things are

- `src/edit/run.ts`: `runEdit(request, { course, snapshot, sources }, models)`. Pure, like `buildCourse`.
- `src/edit/types.ts`: requests (`tune`, `ask`, `add_source`), presets, proposal shape.
- `src/edit/schemas.ts`: the editor's edit list. Agent: `editor` in `src/config/agents.json`.
- `src/releases/changes.ts`: new ops `insert_block`, `add_section`, `add_lesson`, `add_items`, each with an
  inverse-only partner (`remove_block` now inverts any block, `remove_section`, `remove_lesson`,
  `remove_items`). Tiers: text R1, lessons and questions R2. Bumps: minor, a lesson major.
- Service (`src/app/service.ts`): `beginEdit` / `continueEdit` (background) / `applyEdit` / `discardEdit`,
  state in `overview.edit`. Callables `requestEdit`, `applyEdit`, `discardEdit`: owner before publishing;
  anyone with `repair` (owner, editors, admins) after.
- UI: `web/src/components/EditPanel.tsx` (AskForm, TuneForm, EditStatus), `TuneButton.tsx`.

## Decisions

- **Rewrites archive, never overwrite.** Old blocks are archived and new ones inserted with new ids, so the
  history drawer shows exactly what changed and a revert restores the original.
- **Presets map to evidence**, not to vague "more X": worked example, segmenting, personalization, signaling,
  plainer language, applied practice. Course-wide "simpler for everyone" is deliberately absent (expertise
  reversal): use the audience setting at build time, or tune one section.
- **Published edits aren't trialled.** An owner's request has no measurable hypothesis like a misconception
  fix; the owner reviewed the exact changes, so it releases on apply with `approval.by = "human"`. Refused
  while a trial or a repair run is open, and if the live version moved since the proposal.
- **New files can join a published course**; cited files still can't be removed or changed.
- **Questions added to an existing lesson** reuse its misconceptions (given by number, names = ids) and skip
  only the whole-pool checks (`assessmentFromDraft(..., { added: true })`).
- **The editor sees** the course outline, a page index (first line of each material page) and, for a new
  file, its key ideas. Assessments are never cited.

## Not done

- Spaced/interleaved review questions from earlier lessons.
- Undo for a draft edit (rebuild, or apply another edit); published edits revert like any release.
- Edits on the featured course (it has no source pages to ground rewrites in).
