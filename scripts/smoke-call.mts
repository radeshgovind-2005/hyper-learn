// Local smoke tests only (wrangler dev with AUTH_DEV_BYPASS): calls a course as a named user.
//   npx tsx scripts/smoke-call.mts <course> <user> <role> <method> [json args]
// `setModelKey` with args "env" reads MODEL_API_KEY from .env, so the key is never typed or printed.
import { readFileSync } from "node:fs";
import { AgentClient } from "agents/client";

const [course, user, role, method, raw] = process.argv.slice(2);
let args: unknown[] = raw ? (JSON.parse(raw) as unknown[]) : [];
if (method === "setModelKey" && raw === '"env"') {
  const key = /^MODEL_API_KEY=(\S+)/m.exec(readFileSync(".env", "utf8"))![1]!;
  args = [key, "muse-spark-1.3"];
}
// AGENT=directory-agent (course "main") reaches the directory, e.g. to join with an invite.
const client = new AgentClient({ agent: process.env.AGENT ?? "course-agent", name: course!, host: process.env.SMOKE_HOST ?? "localhost:8787", query: { devUser: user!, devRole: role! } });
await new Promise<void>((resolve, reject) => {
  client.addEventListener("open", () => resolve());
  client.addEventListener("close", (e) => reject(new Error(`closed ${(e as CloseEvent).code}`)));
});
try {
  const out = await client.call(method!, args);
  console.log(JSON.stringify(out, null, 1)?.slice(0, Number(process.env.MAX ?? 4000)));
} catch (e) {
  console.log("ERROR", e instanceof Error ? e.message : e);
}
client.close();
process.exit(0);
