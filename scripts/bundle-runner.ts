// Copies the sandbox runner TypeScript source into a .ts.txt file so Wrangler
// will bundle it as text (via the built-in Text loader) and the E2B provider
// can import it as a string constant.
//
// Runs before `wrangler dev` / `wrangler deploy` / `vitest`.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

const SRC = resolve(__dirname, "..", "src/runner/sandbox-runner.ts");
const OUT = resolve(__dirname, "..", "src/runner/sandbox-runner.ts.txt");

const code = readFileSync(SRC, "utf-8");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, code);
console.log(`[bundle-runner] wrote ${OUT} (${code.length} bytes)`);
