import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_PATHS = ["mobile/app", "mobile/components", "mobile/services", "mobile/app.config.ts", "mobile/theme.ts", "shared/src", "worker/src"];
const TEXT_PATHS = ["worker/public"];
const FORBIDDEN = /goal/i;

function files(path: string, accept: (file: string) => boolean): string[] {
  const absolute = join(root, path);
  if (statSync(absolute).isFile()) return accept(absolute) ? [absolute] : [];
  return readdirSync(absolute).flatMap((entry) => (entry === "node_modules" ? [] : files(join(path, entry), accept)));
}

/** Every piece of text a user could see: string literals, template text, and JSX text. */
function userFacingText(file: string, text = readFileSync(file, "utf8")): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text);
    else if (ts.isJsxText(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("criterion 14: no 'goal' in the UI", () => {
  it("never appears in app, shared, or Worker copy", () => {
    const sources = SOURCE_PATHS.flatMap((dir) => files(dir, (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)));
    expect(sources.length).toBeGreaterThan(40);
    const offenders = sources.flatMap((file) =>
      userFacingText(file)
        .filter((text) => FORBIDDEN.test(text))
        .map((text) => `${relative(root, file)}: ${JSON.stringify(text.trim().slice(0, 80))}`),
    );
    expect(offenders).toEqual([]);
  });

  it("never appears on the public site", () => {
    const offenders = TEXT_PATHS.flatMap((path) => files(path, (file) => /\.(json|html)$/.test(file)))
      .filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it("catches the word in string literals, templates, and JSX text but not identifiers", () => {
    const check = (snippet: string) => userFacingText("sample.tsx", snippet).some((text) => FORBIDDEN.test(text));
    expect(check(`const a = "Daily goal";`)).toBe(true);
    expect(check("const a = `${n} kcal under your goal`;")).toBe(true);
    expect(check("const a = <Text>Hit your Goal</Text>;")).toBe(true);
    expect(check("const a = <Text label='goals' />;")).toBe(true);
    expect(check("const goals = store.goals; setGoals(goals);")).toBe(false);
  });
});

describe("plan days are described against the baseline", () => {
  const RETIRED = /\b(Deficit|Surplus)\b|\bNet [+-−]?\d/;

  it("never shows Deficit, Surplus, or Net +N in app, shared, or Worker copy", () => {
    const sources = SOURCE_PATHS.flatMap((dir) => files(dir, (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)));
    const offenders = sources.flatMap((file) =>
      userFacingText(file)
        .filter((text) => RETIRED.test(text))
        .map((text) => `${relative(root, file)}: ${JSON.stringify(text.trim().slice(0, 80))}`),
    );
    expect(offenders).toEqual([]);
    expect(RETIRED.test("Net +0 · Burn 500+")).toBe(true);
    expect(RETIRED.test("Deficit 500+")).toBe(true);
    expect(RETIRED.test("deficit")).toBe(false);
  });
});
