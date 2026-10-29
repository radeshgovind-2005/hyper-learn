import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Command, MemorySaver } from "@langchain/langgraph";
import { getCourse } from "../course/load.js";
import { referenceCurator } from "../eval/reference.js";
import { buildGraph, type GraphModels } from "../graph.js";
import { SimMeasurer } from "../measure/measure.js";
import type { ApprovalRequest, ApprovalResponse, Approver, Harness } from "../nodes/release.js";
import { describeChange } from "../releases/changes.js";
import { MemoryReleaseStore, type ReleaseStore } from "../releases/release.js";
import { injectedProposal, scenarioPerformance, scenarioSnapshot } from "../simulation/index.js";
import { getScenario, type Scenario } from "../simulation/scenarios.js";
import type { State } from "../state.js";
import { describeMutation, printData } from "./format.js";

/**
 * Runs one scenario through the whole loop: diagnose → propose → review → release a candidate →
 * approval → trial on simulated learners → keep or revert. Prints the release history at the end.
 *
 *   npm run loop -- missing-prereq             rule-based Curator (no model calls); asks you to approve
 *   npm run loop -- missing-prereq --agents    the real Curator and Reflection agents
 *   npm run loop -- harmful-edge --yes         approve without asking (also --no)
 *   npm run loop -- missing-prereq --autopilot  autopilot approves within its ceiling; above it, asks
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);

/** Without --agents: the rule-based reference proposes (or the scenario's injected proposal), and review only runs the code checks. */
function referenceModels(scenario: Scenario, data: State["performance_data"]): Partial<GraphModels> {
  return {
    curator: { invoke: async () => injectedProposal(scenario, data) ?? referenceCurator(data) },
    reflection: { invoke: async () => ({ approved: true, critique: "No model review in a reference run: code checks only." }) },
  };
}

/** Autopilot's approver for now: approves whatever reaches it (the ceiling is enforced in code before it). */
const approveWithinCeiling: Approver = async (request) => ({ approved: true, note: `within autopilot's ceiling (${request.tier})` });

async function askHuman(request: ApprovalRequest): Promise<ApprovalResponse> {
  console.log(`\n✋ Approval needed${request.escalated ? ` (${request.escalated})` : ""}`);
  console.log(`   ${request.parent} → ${request.version}   risk ${request.tier}, ${request.bump} bump`);
  for (const change of request.changes) console.log(`   • ${change}`);
  console.log(`   why: ${request.rationale}`);
  if (flag("yes") || flag("no")) {
    const approved = flag("yes");
    console.log(`   ${approved ? "approved" : "rejected"} (--${approved ? "yes" : "no"})`);
    return { approved, note: `--${approved ? "yes" : "no"}` };
  }
  if (!process.stdin.isTTY) throw new Error("Approval needs an answer: run in a terminal, or pass --yes or --no");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("   Approve this release? [y/N] ")).trim().toLowerCase();
  rl.close();
  return { approved: answer === "y" || answer === "yes", note: "answered in the terminal" };
}

function printHistory(store: ReleaseStore) {
  console.log(`\n${"═".repeat(70)}\n📦 Release history\n${"═".repeat(70)}`);
  for (const r of store.all()) {
    const live = r.status === "live" ? " ◀ live" : "";
    console.log(`  ${r.version.padEnd(16)} ${r.status.padEnd(10)} ${r.tier}  ${r.changes.map(describeChange).join("; ") || "(initial)"}${live}`);
    if (r.released_from) {
      console.log(`  ${"".padEnd(16)} released from trial ${r.released_from}`);
      continue;
    }
    if (r.approval) console.log(`  ${"".padEnd(16)} approval: ${r.approval.approved ? "yes" : "no"} by ${r.approval.by}`);
    for (const reason of r.decision?.reasons ?? []) console.log(`  ${"".padEnd(16)} ${r.decision!.verdict}: ${reason}`);
    if (r.promoted_to) console.log(`  ${"".padEnd(16)} released as ${r.promoted_to}`);
  }
}

async function main() {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) throw new Error("Usage: npm run loop -- <scenario> [--agents] [--autopilot] [--yes|--no]");
  const scenario = getScenario(id);

  console.log(`\n${"═".repeat(70)}\n🔁 ${scenario.title}\n${"═".repeat(70)}\n${scenario.description}\n`);
  const data = scenarioPerformance(scenario);
  printData(data);
  console.log(
    `\n  Curator: ${flag("agents") ? "agents (model)" : scenario.inject ? `injected proposal ${describeMutation(scenario.inject)}` : "rule-based reference (no model)"}` +
      `   approval: ${flag("autopilot") ? "autopilot" : "human (HITL)"}   learners: simulated\n`,
  );

  const store = new MemoryReleaseStore(scenarioSnapshot(scenario));
  const harness: Harness = {
    store,
    measurer: new SimMeasurer(getCourse(), scenario),
    mode: flag("autopilot") ? "autopilot" : "hitl",
    approver: approveWithinCeiling,
  };
  const app = buildGraph(flag("agents") ? {} : referenceModels(scenario, data), { harness, checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: randomUUID() }, recursionLimit: 25 };

  let input: Parameters<typeof app.invoke>[0] = { input_type: "cron", performance_data: data };
  for (;;) {
    await app.invoke(input, config);
    const pending = (await app.getState(config)).tasks.flatMap((task) => task.interrupts);
    if (pending.length === 0) break;
    input = new Command({ resume: await askHuman(pending[0]!.value as ApprovalRequest) });
  }

  const final = (await app.getState(config)).values as State;
  if (final.release_problems) console.log(`\n  Nothing released: ${final.release_problems.join("; ")}`);
  printHistory(store);
}

main().catch((error: unknown) => {
  console.error("💥 Loop failed:", error);
  process.exitCode = 1;
});
