// A small arithmetic language for the explorer widget's formulas, parsed and evaluated here: numbers,
// named variables, + - * / ^, parentheses, and min, max, log, sqrt, exp, abs. Nothing else exists in it,
// so a formula can't reach a property, a global or a function the code didn't list: no eval, no
// Function, no lookups by name on an object. The web app has its own copy (web/src/expr.ts); the two
// are kept identical by a test.

export type Expr =
  | { op: "num"; value: number }
  | { op: "var"; name: string }
  | { op: "neg"; arg: Expr }
  | { op: "+" | "-" | "*" | "/" | "^"; left: Expr; right: Expr }
  | { op: "call"; fn: FnName; args: Expr[] };

const FUNCTIONS = {
  min: { arity: [2, 4], run: (a: number[]) => Math.min(...a) },
  max: { arity: [2, 4], run: (a: number[]) => Math.max(...a) },
  log: { arity: [1, 1], run: (a: number[]) => Math.log(a[0]!) },
  sqrt: { arity: [1, 1], run: (a: number[]) => Math.sqrt(a[0]!) },
  exp: { arity: [1, 1], run: (a: number[]) => Math.exp(a[0]!) },
  abs: { arity: [1, 1], run: (a: number[]) => Math.abs(a[0]!) },
} as const;
export type FnName = keyof typeof FUNCTIONS;
const isFn = (name: string): name is FnName => Object.hasOwn(FUNCTIONS, name);

export const MAX_FORMULA_CHARS = 200;
const MAX_TOKENS = 120;
const MAX_DEPTH = 24;

export class FormulaError extends Error {}

type Token = { kind: "num"; value: number } | { kind: "name"; name: string } | { kind: "sym"; sym: string };

function tokenize(text: string): Token[] {
  if (text.length > MAX_FORMULA_CHARS) throw new FormulaError(`A formula can be at most ${MAX_FORMULA_CHARS} characters`);
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const number = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(text.slice(i));
    if (number) {
      tokens.push({ kind: "num", value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]{0,15}/.exec(text.slice(i));
    if (name) {
      tokens.push({ kind: "name", name: name[0] });
      i += name[0].length;
      continue;
    }
    if ("+-*/^(),".includes(c)) {
      tokens.push({ kind: "sym", sym: c });
      i++;
      continue;
    }
    throw new FormulaError(`"${c}" can't be used in a formula`);
  }
  if (tokens.length > MAX_TOKENS) throw new FormulaError("The formula is too long");
  return tokens;
}

/** Parses a formula. Throws FormulaError naming what is wrong. `variables`: the only names it may use. */
export function parseFormula(text: string, variables: readonly string[]): Expr {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const isSym = (sym: string) => {
    const t = peek();
    return t?.kind === "sym" && t.sym === sym;
  };
  const expect = (sym: string) => {
    if (!isSym(sym)) throw new FormulaError(`Expected "${sym}"`);
    at++;
  };

  // expr := term (("+" | "-") term)* ; term := unary (("*" | "/") unary)* ; unary := "-" unary | power ;
  // power := atom ("^" unary)? (right-associative) ; atom := number | name | fn "(" args ")" | "(" expr ")"
  const expr = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new FormulaError("The formula is nested too deeply");
    let left = term(depth + 1);
    while (isSym("+") || isSym("-")) {
      const op = (tokens[at++] as { sym: "+" | "-" }).sym;
      left = { op, left, right: term(depth + 1) };
    }
    return left;
  };
  const term = (depth: number): Expr => {
    let left = unary(depth + 1);
    while (isSym("*") || isSym("/")) {
      const op = (tokens[at++] as { sym: "*" | "/" }).sym;
      left = { op, left, right: unary(depth + 1) };
    }
    return left;
  };
  const unary = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new FormulaError("The formula is nested too deeply");
    if (isSym("-")) {
      at++;
      return { op: "neg", arg: unary(depth + 1) };
    }
    if (isSym("+")) {
      at++;
      return unary(depth + 1);
    }
    const base = atom(depth + 1);
    if (isSym("^")) {
      at++;
      return { op: "^", left: base, right: unary(depth + 1) };
    }
    return base;
  };
  const atom = (depth: number): Expr => {
    const t = peek();
    if (!t) throw new FormulaError("The formula ends too early");
    if (t.kind === "num") {
      at++;
      return { op: "num", value: t.value };
    }
    if (t.kind === "name") {
      at++;
      if (isSym("(")) {
        if (!isFn(t.name)) throw new FormulaError(`"${t.name}" isn't a function you can use (only ${Object.keys(FUNCTIONS).join(", ")})`);
        at++;
        const args = [expr(depth + 1)];
        while (isSym(",")) {
          at++;
          args.push(expr(depth + 1));
        }
        expect(")");
        const [lo, hi] = FUNCTIONS[t.name].arity;
        if (args.length < lo || args.length > hi) throw new FormulaError(`${t.name} takes ${lo === hi ? lo : `${lo} to ${hi}`} argument(s)`);
        return { op: "call", fn: t.name, args };
      }
      if (!variables.includes(t.name)) throw new FormulaError(`"${t.name}" isn't one of the parameters (${variables.join(", ") || "none"})`);
      return { op: "var", name: t.name };
    }
    if (t.sym === "(") {
      at++;
      const inner = expr(depth + 1);
      expect(")");
      return inner;
    }
    throw new FormulaError(`Unexpected "${t.sym}"`);
  };

  const tree = expr(0);
  if (at < tokens.length) throw new FormulaError(`Unexpected "${(tokens[at] as { sym?: string; name?: string }).sym ?? (tokens[at] as { name?: string }).name ?? "number"}"`);
  return tree;
}

/** The formula's value for these variable values (NaN or ±Infinity where the maths has none). */
export function evaluate(tree: Expr, values: Readonly<Record<string, number>>): number {
  switch (tree.op) {
    case "num":
      return tree.value;
    case "var":
      return Object.hasOwn(values, tree.name) ? values[tree.name]! : Number.NaN;
    case "neg":
      return -evaluate(tree.arg, values);
    case "+":
      return evaluate(tree.left, values) + evaluate(tree.right, values);
    case "-":
      return evaluate(tree.left, values) - evaluate(tree.right, values);
    case "*":
      return evaluate(tree.left, values) * evaluate(tree.right, values);
    case "/":
      return evaluate(tree.left, values) / evaluate(tree.right, values);
    case "^":
      return evaluate(tree.left, values) ** evaluate(tree.right, values);
    case "call":
      return FUNCTIONS[tree.fn].run(tree.args.map((a) => evaluate(a, values)));
  }
}
