// Spike helper: reads .env without printing secrets.
import { readFileSync } from "node:fs";
export function env(name: string): string {
  const line = readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return (line?.slice(name.length + 1) ?? "").replace(/\s+#.*$/, "").replace(/#.*$/, "").trim();
}
