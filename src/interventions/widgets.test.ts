import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { widgetProblems } from "./checks.js";
import { evaluate, FormulaError, parseFormula } from "./expr.js";
import { EXEMPLARS } from "./exemplars.js";
import { type Intervention, InterventionSchema } from "./templates.js";

// The explorer and compare widgets: JSON that the UI renders, with formulas in a tiny language that code
// parses and evaluates. Nothing in a formula can reach outside it.

const amdahl = {
  template: "explorer",
  targets: "more-cores-always-faster",
  title: "Amdahl's law",
  formula: "1 / ((1 - p) + p / N)",
  result_label: "Speedup",
  parameters: [
    { name: "N", label: "Number of cores", min: 1, max: 64, step: 1, value: 8 },
    { name: "p", label: "Parallel fraction", min: 0, max: 0.99, step: 0.01, value: 0.9 },
  ],
  plot: "N",
  takeaway: "With 10% serial work, speedup can't pass 10 however many cores you add.",
} as const;

const numa = {
  template: "compare",
  targets: "all-memory-is-equally-fast",
  title: "UMA vs NUMA",
  cases: [
    { label: "UMA", points: ["Every core reaches memory at the same speed"], figure: { label: "Latency", value: 100, unit: "ns" } },
    { label: "NUMA", points: ["Local memory is fast", "Remote memory crosses the interconnect"], figure: { label: "Remote latency", value: 180, unit: "ns" } },
  ],
  takeaway: "On NUMA, where data lives decides how fast it is read.",
} as const;

const explorer = (patch: Record<string, unknown>) => InterventionSchema.parse({ ...amdahl, ...patch }) as Intervention;

describe("formulas", () => {
  it("evaluate arithmetic with precedence, right-associative powers and functions", () => {
    const value = (f: string, v: Record<string, number> = {}) => evaluate(parseFormula(f, Object.keys(v)), v);
    assert.equal(value("1 + 2 * 3"), 7);
    assert.equal(value("2 ^ 3 ^ 2"), 512);
    assert.equal(value("-2 ^ 2"), -4);
    assert.equal(value("min(3, x, 9) + max(1, 2)", { x: 2 }), 4);
    assert.equal(value("sqrt(16) + abs(-1) + log(exp(2))"), 7);
    assert.ok(Math.abs(value("1 / ((1 - p) + p / N)", { p: 0.9, N: 8 }) - 4.7058823529) < 1e-9);
    assert.equal(value("1.5e2"), 150);
  });

  it("refuse anything that isn't arithmetic over the parameters", () => {
    const hostile = [
      "constructor",
      "process.exit(1)",
      "a.b",
      "N.constructor",
      "globalThis",
      "this",
      'eval("1")',
      "Function(1)",
      "x[0]",
      "N; 1",
      "`1`",
      "'1'",
      "N = 2",
      "__proto__",
      "toString(N)",
      "hasOwnProperty(N)",
      "1 +",
      "(1",
      "min(1)",
      "sqrt(1, 2)",
      "1 ".repeat(150),
      `${"(".repeat(40)}1${")".repeat(40)}`,
    ];
    for (const formula of hostile) assert.throws(() => parseFormula(formula, ["N", "p"]), FormulaError, formula);
  });

  it("never reads a variable that wasn't given, even one named like an object key", () => {
    const tree = parseFormula("N + 1", ["N"]);
    assert.ok(Number.isNaN(evaluate(tree, {})));
    assert.ok(Number.isNaN(evaluate(parseFormula("constructor_", ["constructor_"]), {})));
  });

  it("the web app's copy is the same file", () => {
    const core = readFileSync(new URL("./expr.ts", import.meta.url), "utf8");
    const web = readFileSync(new URL("../../web/src/expr.ts", import.meta.url), "utf8");
    assert.equal(web, core);
  });
});

describe("the explorer and compare templates", () => {
  it("accept Amdahl's law and UMA vs NUMA", () => {
    assert.deepEqual(widgetProblems(InterventionSchema.parse(amdahl)), []);
    assert.deepEqual(widgetProblems(InterventionSchema.parse(numa)), []);
  });

  it("refuse hostile or broken formulas, with a message the author can act on", () => {
    const cases: [string, RegExp][] = [
      ["constructor", /isn't one of the parameters/],
      ["process.exit(1)", /isn't one of the parameters|can't be used/],
      ["N.p", /can't be used/],
      ["2 ^ (N * 100)", /runaway|infinity/],
      ["1 / (N - 1)", /infinity/],
      ["log(p - 1)", /no number/],
      ["sqrt(-N)", /no number/],
    ];
    for (const [formula, message] of cases) {
      const problems = widgetProblems(explorer({ formula }));
      assert.equal(problems.length, 1, formula);
      assert.match(problems[0]!, message, formula);
    }
  });

  it("refuse bad ranges, a missing plot axis, more than four parameters and duplicate names", () => {
    assert.match(widgetProblems(explorer({ plot: "x" }))[0]!, /plot "x" isn't one of the parameters/);
    assert.match(widgetProblems(explorer({ parameters: [{ ...amdahl.parameters[0], min: 5, max: 5 }, amdahl.parameters[1]] }))[0]!, /min must be below max/);
    assert.match(widgetProblems(explorer({ parameters: [{ ...amdahl.parameters[0], value: 100 }, amdahl.parameters[1]] }))[0]!, /starting value/);
    assert.match(widgetProblems(explorer({ parameters: [{ ...amdahl.parameters[0], step: 0.0001 }, amdahl.parameters[1]] }))[0]!, /at most 1000 steps/);
    assert.match(widgetProblems(explorer({ parameters: [amdahl.parameters[0], { ...amdahl.parameters[1], name: "N" }] }))[0]!, /share a name/);
    const five = Array.from({ length: 5 }, (_, i) => ({ ...amdahl.parameters[1], name: `p${i}` }));
    assert.ok(!InterventionSchema.safeParse({ ...amdahl, parameters: five }).success);
    assert.ok(!InterventionSchema.safeParse({ ...amdahl, parameters: [{ ...amdahl.parameters[0], name: "a.b" }] }).success);
  });

  it("refuse a compare with the same label twice or a negative number, and one with three cases", () => {
    const same = InterventionSchema.parse({ ...numa, cases: [numa.cases[0], { ...numa.cases[1], label: "uma" }] });
    assert.match(widgetProblems(same)[0]!, /different labels/);
    const negative = InterventionSchema.parse({ ...numa, cases: [numa.cases[0], { ...numa.cases[1], figure: { label: "x", value: -1, unit: "ns" } }] });
    assert.match(widgetProblems(negative)[0]!, /not negative/);
    assert.ok(!InterventionSchema.safeParse({ ...numa, cases: [...numa.cases, numa.cases[0]] }).success);
  });

  it("leave the existing three templates as they were", () => {
    for (const exemplar of EXEMPLARS) {
      assert.deepEqual(InterventionSchema.parse(exemplar), exemplar);
      assert.deepEqual(widgetProblems(exemplar), []);
    }
    assert.deepEqual(new Set(EXEMPLARS.map((e) => e.template)), new Set(["contrast", "practice", "step_through"]));
  });
});
