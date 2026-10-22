/**
 * Type-checks every ```ts snippet in README.md without writing temporary files
 * or executing the examples. Pass a local Markdown file as argv[2] to check an
 * older README against the current public types.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface Snippet {
  /** 1-based line of the opening fence. */
  line: number;
  code: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(repoRoot, "README.md");

function extractSnippets(markdown: string): Snippet[] {
  const snippets: Snippet[] = [];
  const fence = /^```ts[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

  for (let match = fence.exec(markdown); match !== null; match = fence.exec(markdown)) {
    const line = markdown.slice(0, match.index).split(/\r?\n/).length;
    snippets.push({ line, code: match[1] });
  }

  return snippets;
}

function hasDeclaration(code: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(code);
}

/**
 * Adds only the context an example explicitly relies on. Virtual source files
 * live at the repository root so NodeNext sees the package's `"type": "module"`.
 */
function addExampleContext(snippet: Snippet): string {
  const context: string[] = [];

  if (!hasDeclaration(snippet.code, "client")) {
    context.push('import type { DataClient as QAClient } from "@blockvectra/data-api";');
    context.push("declare const client: QAClient;");
  }
  if (!hasDeclaration(snippet.code, "chain")) {
    context.push("declare const chain: string;");
  }
  if (/\bhead\b/.test(snippet.code) && !hasDeclaration(snippet.code, "head")) {
    context.push("declare const head: number;");
  }
  if (/\bprocess\s*\.\s*env\b/.test(snippet.code)) {
    context.push("declare const process: { env: Record<string, string | undefined> };");
  }

  const prefix = context.length > 0 ? `${context.join("\n")}\n` : "";
  return `${prefix}${snippet.code}\nexport {};\n`;
}

function main(): void {
  const markdown = fs.readFileSync(readmePath, "utf8");
  const snippets = extractSnippets(markdown);

  if (snippets.length === 0) {
    console.error(`No \`\`\`ts code snippets found in ${readmePath}.`);
    process.exitCode = 1;
    return;
  }

  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    skipLibCheck: true,
    esModuleInterop: true,
    isolatedModules: true,
    types: [],
    baseUrl: repoRoot,
    paths: {
      "@blockvectra/data-api": ["src/index.ts"],
    },
  };

  const virtualFiles = snippets.map((_, index) =>
    path.join(repoRoot, `__readme_snippet_${index + 1}.ts`),
  );
  const virtualSources = new Map(
    virtualFiles.map((fileName, index) => [
      path.resolve(fileName),
      addExampleContext(snippets[index]),
    ]),
  );

  const host = ts.createCompilerHost(options, true);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const source = virtualSources.get(path.resolve(fileName));
    if (source !== undefined) {
      return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    }
    return defaultGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  host.fileExists = (fileName) =>
    virtualSources.has(path.resolve(fileName)) || defaultFileExists(fileName);
  host.readFile = (fileName) => virtualSources.get(path.resolve(fileName)) ?? defaultReadFile(fileName);

  const program = ts.createProgram({ rootNames: virtualFiles, options, host });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => repoRoot,
      getNewLine: () => "\n",
    });
    console.error(formatted.trimEnd());
    console.error(
      `README typecheck failed: ${diagnostics.length} diagnostic(s) across ${snippets.length} snippet(s) from ${readmePath}.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `README typecheck passed: checked ${snippets.length} TypeScript snippet(s) from ${readmePath}.`,
  );
}

main();
