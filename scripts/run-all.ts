#!/usr/bin/env tsx
/**
 * scripts/run-all.ts — offline smoke test for every chapter.
 *
 * Runs each sNN_slug/code.ts with no API key (the built-in offline demo model)
 * and a bounded stdin, and reports pass/fail. A chapter "passes" if the process
 * exits with code 0 within the timeout.
 *
 *   npm test            # run all chapters
 *   npx tsx scripts/run-all.ts s05 s12   # run a subset
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 45_000;

function chapterDirs(): { id: string; dir: string }[] {
  const all = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^s\d{2}_/.test(e.name))
    .map((e) => ({ id: e.name.slice(0, 3), dir: e.name }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const wanted = process.argv.slice(2);
  if (wanted.length === 0) return all;
  return all.filter((c) => wanted.includes(c.id));
}

function runChapter(dir: string): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", path.join(dir, "code.ts")], {
      cwd: ROOT,
      env: { ...process.env, OPENAI_API_KEY: "", CODEX_OFFLINE: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    // Feed a generic task then quit, in case the chapter runs a REPL.
    child.stdin.write("summarize the current directory\nq\n");
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, tail: out.slice(-400) });
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, tail: out.slice(-400) });
    });
  });
}

async function main(): Promise<void> {
  const chapters = chapterDirs();
  console.log(`Running ${chapters.length} chapter(s) offline...\n`);
  let failed = 0;
  for (const c of chapters) {
    const file = path.join(ROOT, c.dir, "code.ts");
    if (!fs.existsSync(file)) {
      console.log(`  ✗ ${c.id} (${c.dir}) — missing code.ts`);
      failed++;
      continue;
    }
    const { code, tail } = await runChapter(c.dir);
    if (code === 0) {
      console.log(`  ✓ ${c.id} (${c.dir})`);
    } else {
      failed++;
      console.log(`  ✗ ${c.id} (${c.dir}) — exit ${code === null ? "TIMEOUT" : code}`);
      if (tail.trim()) console.log(`      tail: ${tail.trim().split("\n").slice(-3).join(" | ")}`);
    }
  }
  console.log(`\n${chapters.length - failed}/${chapters.length} chapters passed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
