import { type CourseSnapshot, courseFromSnapshot } from "../course/compile.js";
import type { Measurement, TrialDecision } from "../measure/decide.js";
import {
  applyChanges,
  type Bump,
  type Change,
  ChangeError,
  invertChanges,
  maxBump,
  maxTier,
  type RiskTier,
  riskTier,
  semverBump,
} from "./changes.js";

// Releases: every change to the course is a new version. A candidate runs as a trial
// ("1.1.0-trial.1") next to the live release; measurement decides whether it is promoted
// (becoming "1.1.0") or reverted. Nothing is ever overwritten, so history is complete.

export type ReleaseStatus = "live" | "superseded" | "trial" | "promoted" | "reverted" | "rejected";

export interface Approval {
  approved: boolean;
  by: "human" | "autopilot";
  note?: string;
}

export interface Release {
  version: string;
  /** The release this one was built on. */
  parent: string | null;
  status: ReleaseStatus;
  changes: Change[];
  /** Applying these to this release's snapshot gives back the parent's. */
  inverse: Change[];
  tier: RiskTier;
  bump: Bump;
  snapshot: CourseSnapshot;
  /** Why the change was proposed (the proposal's reason). */
  rationale?: string;
  approval?: Approval;
  measurement?: Measurement;
  decision?: TrialDecision;
  /** For a promoted trial: the version it was released as. */
  promoted_to?: string;
  /** For a release that came from a trial: that trial's version. */
  released_from?: string;
  created_at: string;
}

// ─── Versions ──────────────────────────────────────────────────────

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-trial\.(\d+))?$/;

export function parseVersion(version: string) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`Invalid version "${version}"`);
  const [major, minor, patch, trial] = match.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  return { major: major!, minor: minor!, patch: patch!, trial };
}

/** The next release version after `version` for a bump: 1.2.3 + minor → 1.3.0. */
export function bumpVersion(version: string, bump: Bump): string {
  const { major, minor, patch } = parseVersion(version);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** A trial version for `base` that no existing release uses: 1.1.0-trial.1, -trial.2… */
export function trialVersion(base: string, existing: readonly string[]): string {
  const n = existing.filter((v) => v.startsWith(`${base}-trial.`)).length + 1;
  return `${base}-trial.${n}`;
}

// ─── Store ─────────────────────────────────────────────────────────

/** Where releases live. In memory for the CLI and tests; Durable Object storage in the Worker. */
export interface ReleaseStore {
  live(): Release;
  get(version: string): Release | undefined;
  all(): Release[];
  add(release: Release): void;
  update(version: string, patch: Partial<Release>): Release;
}

export class MemoryReleaseStore implements ReleaseStore {
  private readonly releases = new Map<string, Release>();

  constructor(
    initial: CourseSnapshot,
    now = () => new Date().toISOString(),
  ) {
    this.add({
      version: initial.version,
      parent: null,
      status: "live",
      changes: [],
      inverse: [],
      tier: "R0",
      bump: "major",
      snapshot: initial,
      rationale: "Compiled from the course content",
      created_at: now(),
    });
  }

  live(): Release {
    const live = [...this.releases.values()].find((r) => r.status === "live");
    if (!live) throw new Error("No live release");
    return live;
  }
  get(version: string) {
    return this.releases.get(version);
  }
  all() {
    return [...this.releases.values()];
  }
  add(release: Release) {
    if (this.releases.has(release.version)) throw new Error(`Release ${release.version} already exists`);
    this.releases.set(release.version, structuredClone(release));
  }
  update(version: string, patch: Partial<Release>) {
    const release = this.releases.get(version);
    if (!release) throw new Error(`No release ${version}`);
    const next = { ...release, ...structuredClone(patch) };
    this.releases.set(version, next);
    return next;
  }
}

// ─── Planning, promotion, revert ───────────────────────────────────

export type ReleasePlan = { ok: true; candidate: Release } | { ok: false; problems: string[] };

/**
 * Builds a candidate release from the live one: applies the changes to a copy, re-validates the whole
 * course (every invariant the loader enforces), and assigns the risk tier and version in code.
 */
export function planRelease(store: ReleaseStore, changes: Change[], rationale: string, now = () => new Date().toISOString()): ReleasePlan {
  if (changes.length === 0) return { ok: false, problems: ["the proposal changes nothing"] };
  const live = store.live();

  let snapshot: CourseSnapshot;
  try {
    snapshot = applyChanges(live.snapshot, changes);
  } catch (error) {
    if (error instanceof ChangeError) return { ok: false, problems: [error.message] };
    throw error;
  }
  try {
    courseFromSnapshot(snapshot);
  } catch (error) {
    const lines = (error as Error).message.split("\n- ").slice(1);
    return { ok: false, problems: lines.length > 0 ? lines : [(error as Error).message] };
  }

  const bump = maxBump(changes.map((c) => semverBump(live.snapshot, c)));
  const version = trialVersion(
    bumpVersion(live.version, bump),
    store.all().map((r) => r.version),
  );
  return {
    ok: true,
    candidate: {
      version,
      parent: live.version,
      status: "trial",
      changes,
      inverse: invertChanges(live.snapshot, changes),
      tier: maxTier(changes.map((c) => riskTier(live.snapshot, c))),
      bump,
      snapshot: { ...snapshot, version },
      rationale,
      created_at: now(),
    },
  };
}

/** Releases a trial: it becomes the new live version, and the previous live one is superseded. */
export function promote(store: ReleaseStore, trialVersionId: string): Release {
  const trial = store.get(trialVersionId);
  if (trial?.status !== "trial") throw new Error(`${trialVersionId} is not a running trial`);
  const live = store.live();
  if (trial.parent !== live.version) throw new Error(`${trialVersionId} was built on ${trial.parent}, but ${live.version} is live`);

  const { major, minor, patch } = parseVersion(trialVersionId);
  const version = `${major}.${minor}.${patch}`;
  store.update(live.version, { status: "superseded" });
  store.update(trialVersionId, { status: "promoted", promoted_to: version });
  const released: Release = {
    ...structuredClone(trial),
    version,
    status: "live",
    released_from: trialVersionId,
    snapshot: { ...trial.snapshot, version },
  };
  store.add(released);
  return released;
}

/** Ends a trial without releasing it. The live release was never touched, so nothing else changes. */
export function revert(store: ReleaseStore, trialVersionId: string): Release {
  const trial = store.get(trialVersionId);
  if (trial?.status !== "trial") throw new Error(`${trialVersionId} is not a running trial`);
  return store.update(trialVersionId, { status: "reverted" });
}
