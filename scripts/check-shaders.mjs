/**
 * Validates every WGSL entry against a real WebGPU device via `vgpu check`.
 *
 * The renderer compiles its shaders lazily in the browser, so a WGSL mistake
 * — a uniformity violation, a bad binding, a renamed builtin — reaches the
 * page as a blank canvas rather than a build failure. This runs the same
 * device-backed validation vgpu uses, ahead of the browser.
 *
 * Entries are the shaders that declare bindings; the rest are pure modules,
 * which vgpu validates transitively as part of each entry that imports them.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SHADER_DIRS = ["src/lib/glass", "src/lib/prism"];
const BINARY = join("node_modules", ".bin", "vgpu");

const shaders = SHADER_DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".wgsl"))
    .map((name) => join(dir, name))
).sort();

// Entries are the shaders that declare bindings; the rest are pure modules,
// which vgpu validates transitively as part of each entry that imports them.
const entries = shaders.filter((path) =>
  /@group\s*\(/.test(readFileSync(path, "utf8"))
);

if (entries.length === 0) {
  console.error("No WGSL entry points found — did the shader directories move?");
  process.exit(1);
}

const results = await Promise.all(
  entries.map(async (path) => {
    const name = path;
    try {
      const { stdout } = await run(BINARY, ["check", path, "--require-validation"]);
      const { validation } = JSON.parse(stdout);
      return { name, ok: validation?.ok === true, detail: validation };
    } catch (error) {
      // A failed check still prints its JSON report on stdout.
      let detail = error.stderr?.trim() || error.message;
      try {
        detail = JSON.parse(error.stdout).validation?.error ?? detail;
      } catch {
        // Not JSON — keep the raw output.
      }
      return { name, ok: false, detail };
    }
  })
);

let failed = 0;
for (const { name, ok, detail } of results) {
  if (ok) {
    console.log(`  ok    ${name}`);
    continue;
  }
  failed++;
  const { line, column, message, code } = detail ?? {};
  console.error(
    line != null
      ? `  FAIL  ${name}:${line}:${column}  ${code}: ${message}`
      : `  FAIL  ${name}  ${JSON.stringify(detail)}`
  );
}

console.log(
  `\n${entries.length - failed}/${entries.length} shader entries validated` +
    ` (${shaders.length - entries.length} modules checked transitively)`
);
process.exit(failed > 0 ? 1 : 0);
