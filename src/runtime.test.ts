import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

// The core must run in a Cloudflare Worker as well as in Node, so only Node entry points may use
// Node-only modules. A failure here means the Worker build would break.
const ROOT = new URL(".", import.meta.url).pathname;
const NODE_ONLY = [/^node\//, /^cli\//, /^eval\/run\.ts$/, /^index\.ts$/, /^course\/load\.ts$/];
const NODE_IMPORT = /from\s+"(node:[^"]+|undici|dotenv[^"]*)"|import\s+"(dotenv[^"]*)"/;

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );

describe("runtime boundary", () => {
  it("keeps Node-only imports out of the core", () => {
    const offenders = files(ROOT)
      .map((file) => relative(ROOT, file))
      .filter((file) => !file.endsWith(".test.ts") && !NODE_ONLY.some((allowed) => allowed.test(file)))
      .filter((file) => NODE_IMPORT.test(readFileSync(join(ROOT, file), "utf8")));
    assert.deepEqual(offenders, []);
  });
});
