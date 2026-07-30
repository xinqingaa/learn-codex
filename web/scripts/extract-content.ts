import * as fs from "fs";
import * as path from "path";
import type {
  AgentVersion,
  VersionDiff,
  DocContent,
  VersionIndex,
  ChapterImage,
} from "../src/types/agent-data";
import { VERSION_META, VERSION_ORDER, LEARNING_PATH } from "../src/lib/constants";

const WEB_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "..");
const OUT_DIR = path.join(WEB_DIR, "src", "data", "generated");
const PUBLIC_DIR = path.join(WEB_DIR, "public");
const COURSE_ASSETS_DIR = path.join(PUBLIC_DIR, "course-assets");

type Locale = "en" | "zh";

interface ChapterSource {
  id: string;
  dirName: string;
  dirPath: string;
  codePath: string;
}

function dirToVersionId(dirName: string): string | null {
  const match = dirName.match(/^(s\d{2})_/);
  return match ? match[1] : null;
}

function listRootChapters(): ChapterSource[] {
  return fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^s\d{2}_/.test(name))
    .sort()
    .map((dirName) => {
      const id = dirToVersionId(dirName);
      if (!id) return null;
      const dirPath = path.join(REPO_ROOT, dirName);
      const codePath = path.join(dirPath, "code.ts");
      if (!fs.existsSync(codePath)) return null;
      return { id, dirName, dirPath, codePath };
    })
    .filter((chapter): chapter is ChapterSource => chapter !== null);
}

function extractClasses(
  lines: string[]
): { name: string; startLine: number; endLine: number }[] {
  const classes: { name: string; startLine: number; endLine: number }[] = [];
  const classPattern = /^(?:export\s+)?class\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(classPattern);
    if (!match) continue;

    const name = match[1];
    const startLine = i + 1;
    // A TypeScript class body ends when its braces balance back to zero.
    let depth = 0;
    let started = false;
    let endLine = lines.length;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (started && depth <= 0) {
        endLine = j + 1;
        break;
      }
    }
    classes.push({ name, startLine, endLine });
  }

  return classes;
}

function extractFunctions(
  lines: string[]
): { name: string; signature: string; startLine: number }[] {
  const functions: { name: string; signature: string; startLine: number }[] = [];
  // export? async? function name(params)
  const funcDeclPattern =
    /^(?:export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;
  // export? const name = async? (params) =>
  const constArrowPattern =
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(async\s+)?\(([^)]*)\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const decl = line.match(funcDeclPattern);
    if (decl) {
      const asyncPrefix = decl[1] ? "async " : "";
      functions.push({
        name: decl[2],
        signature: `${asyncPrefix}function ${decl[2]}(${decl[3]})`,
        startLine: i + 1,
      });
      continue;
    }

    const arrow = line.match(constArrowPattern);
    if (arrow) {
      const asyncPrefix = arrow[2] ? "async " : "";
      functions.push({
        name: arrow[1],
        signature: `const ${arrow[1]} = ${asyncPrefix}(${arrow[3]}) =>`,
        startLine: i + 1,
      });
    }
  }

  return functions;
}

function extractTools(source: string): string[] {
  // Matches both `name: "shell"` and `"name": "shell"` tool definitions.
  const toolPattern = /["']?name["']?\s*:\s*["']([\w-]+)["']/g;
  const tools = new Set<string>();
  let match;
  while ((match = toolPattern.exec(source)) !== null) {
    tools.add(match[1]);
  }
  return Array.from(tools);
}

function countLoc(lines: string[]): number {
  return lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("//");
  }).length;
}

function titleFromMarkdown(content: string, fallback: string): string {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return titleMatch ? titleMatch[1] : fallback;
}

function cleanCourseAssets() {
  fs.rmSync(COURSE_ASSETS_DIR, { recursive: true, force: true });
  fs.mkdirSync(COURSE_ASSETS_DIR, { recursive: true });
}

function copyChapterAssets(chapter: ChapterSource): ChapterImage[] {
  const imagesDir = path.join(chapter.dirPath, "images");
  if (!fs.existsSync(imagesDir)) return [];

  const outDir = path.join(COURSE_ASSETS_DIR, chapter.dirName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(imagesDir, outDir, { recursive: true });

  return fs
    .readdirSync(imagesDir)
    .filter((filename) => filename.endsWith(".svg"))
    .filter((filename) => !filename.includes(".en."))
    .sort()
    .map((filename) => ({
      src: `/course-assets/${chapter.dirName}/${filename}`,
      alt: filename.replace(/\.svg$/, "").replace(/-/g, " "),
    }));
}

function localeReadmeName(locale: Locale): string {
  if (locale === "zh") return "README.md";
  return "README.en.md";
}

function rewriteChapterMarkdown(
  content: string,
  chapter: ChapterSource,
  locale: Locale
): string {
  let next = content;

  // Strip the bilingual nav line: [中文](README.md) · [English](README.en.md)
  next = next.replace(
    /^\[中文\]\(README\.md\)\s*.\s*\[English\]\(README\.en\.md\)\n\n?/m,
    ""
  );

  next = next.replace(
    /(!\[[^\]]*\]\()images\/([^)]+)(\))/g,
    `$1/course-assets/${chapter.dirName}/$2$3`
  );

  next = next.replace(
    /\]\(\.\.\/(s\d{2}_[^)\/]+)\/?\)/g,
    (_match, dirName) => {
      const id = dirToVersionId(dirName);
      return id ? `](/${locale}/${id})` : `](../${dirName}/)`;
    }
  );

  next = next.replace(
    /\]\(\.\/(s\d{2}_[^)\/]+)\/?\)/g,
    (_match, dirName) => {
      const id = dirToVersionId(dirName);
      return id ? `](/${locale}/${id})` : `](./${dirName}/)`;
    }
  );

  return next;
}

function buildRootVersions(chapters: ChapterSource[]): AgentVersion[] {
  return chapters.map((chapter) => {
    const source = fs.readFileSync(chapter.codePath, "utf-8");
    const lines = source.split("\n");
    const meta = VERSION_META[chapter.id];

    return {
      id: chapter.id,
      filename: `${chapter.dirName}/code.ts`,
      title: meta?.title ?? chapter.id,
      subtitle: meta?.subtitle ?? "",
      loc: countLoc(lines),
      tools: extractTools(source),
      newTools: [] as string[],
      coreAddition: meta?.coreAddition ?? "",
      keyInsight: meta?.keyInsight ?? "",
      classes: extractClasses(lines),
      functions: extractFunctions(lines),
      layer: meta?.layer ?? "tools",
      source,
      images: copyChapterAssets(chapter),
    };
  });
}

function buildRootDocs(chapters: ChapterSource[]): DocContent[] {
  const docs: DocContent[] = [];
  const locales: Locale[] = ["en", "zh"];

  for (const chapter of chapters) {
    for (const locale of locales) {
      const filename = localeReadmeName(locale);
      const filePath = path.join(chapter.dirPath, filename);
      if (!fs.existsSync(filePath)) continue;

      const raw = fs.readFileSync(filePath, "utf-8");
      const content = rewriteChapterMarkdown(raw, chapter, locale);
      docs.push({
        version: chapter.id,
        locale,
        title: titleFromMarkdown(content, filename),
        content,
      });
    }
  }

  return docs;
}

function computeNewTools(versions: AgentVersion[]) {
  for (let i = 0; i < versions.length; i++) {
    const prev = i > 0 ? new Set(versions[i - 1].tools) : new Set<string>();
    versions[i].newTools = versions[i].tools.filter((tool) => !prev.has(tool));
  }
}

function buildDiffs(versions: AgentVersion[]): VersionDiff[] {
  const diffs: VersionDiff[] = [];
  const versionMap = new Map(versions.map((version) => [version.id, version]));

  for (let i = 1; i < LEARNING_PATH.length; i++) {
    const fromId = LEARNING_PATH[i - 1];
    const toId = LEARNING_PATH[i];
    const fromVer = versionMap.get(fromId);
    const toVer = versionMap.get(toId);
    if (!fromVer || !toVer) continue;

    const fromClassNames = new Set(fromVer.classes.map((cls) => cls.name));
    const fromFuncNames = new Set(fromVer.functions.map((fn) => fn.name));
    const fromToolNames = new Set(fromVer.tools);

    diffs.push({
      from: fromId,
      to: toId,
      newClasses: toVer.classes
        .map((cls) => cls.name)
        .filter((name) => !fromClassNames.has(name)),
      newFunctions: toVer.functions
        .map((fn) => fn.name)
        .filter((name) => !fromFuncNames.has(name)),
      newTools: toVer.tools.filter((tool) => !fromToolNames.has(tool)),
      locDelta: toVer.loc - fromVer.loc,
    });
  }

  return diffs;
}

function sortVersions(versions: AgentVersion[]) {
  const orderMap = new Map(VERSION_ORDER.map((id, index) => [id, index]));
  versions.sort(
    (a, b) => (orderMap.get(a.id as any) ?? 99) - (orderMap.get(b.id as any) ?? 99)
  );
}

function main() {
  console.log("Extracting course content...");
  console.log(`  Repo root: ${REPO_ROOT}`);

  cleanCourseAssets();

  const rootChapters = listRootChapters();
  console.log(`  Source: root chapter folders (${rootChapters.length})`);

  const versions = buildRootVersions(rootChapters);
  const docs = buildRootDocs(rootChapters);

  sortVersions(versions);
  computeNewTools(versions);
  const diffs = buildDiffs(versions);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const index: VersionIndex = { versions, diffs };
  fs.writeFileSync(path.join(OUT_DIR, "versions.json"), JSON.stringify(index, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "docs.json"), JSON.stringify(docs, null, 2));

  console.log("\nExtraction complete:");
  console.log(`  ${versions.length} versions`);
  console.log(`  ${diffs.length} diffs`);
  console.log(`  ${docs.length} docs`);
  for (const version of versions) {
    console.log(
      `    ${version.id}: ${version.loc} LOC, ${version.tools.length} tools, ${version.classes.length} classes, ${version.functions.length} functions`
    );
  }
}

main();
