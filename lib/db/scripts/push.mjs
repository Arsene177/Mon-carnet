// Applies the Drizzle schema to DATABASE_URL, then closes the tables to Supabase's public API
// (lockdown.mjs). Fails when drizzle-kit reports an error: drizzle-kit itself exits with 0 even when
// it stops, for example at a question it cannot ask without a terminal (a change that would delete
// data), which would otherwise look like a successful push.
//   node scripts/push.mjs [--force]   (--force accepts changes that delete data)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const force = process.argv.includes("--force");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let output = "";
    const relay = (stream, target) => stream.on("data", (chunk) => { output += chunk; target.write(chunk); });
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

const push = await run("npx", ["drizzle-kit", "push", "--config", "./drizzle.config.ts", ...(force ? ["--force"] : [])]);
if (push.code !== 0 || /(^|\n)\s*Error\b|Interactive prompts require a TTY/i.test(push.output)) {
  console.error("\nThe schema was NOT applied. If drizzle-kit wanted to ask about deleting data, review the change and run the push from a terminal (or with --force once you are sure).");
  process.exit(1);
}
const lockdown = await run(process.execPath, [`${here}lockdown.mjs`]);
process.exit(lockdown.code ?? 1);
