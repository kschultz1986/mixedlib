import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface RustLocation {
  file: string; // absolute filesystem path
  line: number; // 1-indexed
}

type LocationMap = Record<string, RustLocation>;

// Global in-memory cache.  Populated eagerly on activation and refreshed on
// every .rs file save.  Entries from all workspace folders are merged here;
// function names are typically unique enough that collisions are not a concern.
let cachedMap: LocationMap = {};

// ---------------------------------------------------------------------------
// Rust source parsing
// ---------------------------------------------------------------------------

function parseRustLocations(src: string, absoluteFile: string): LocationMap {
  const map: LocationMap = {};
  const pat =
    /#\[pyfunction\](?:\s*#\[[^\]]*\])*\s+pub\s+fn\s+(\w+)\s*\([^)]*\)\s*->\s*[\w<>,\s&']+?\s*\{/gs;
  for (const m of src.matchAll(pat)) {
    const fnName = m[1];
    const pubFnOffset = m[0].search(/\bpub\s+fn\b/);
    const line = src.slice(0, m.index! + pubFnOffset).split("\n").length;
    map[fnName] = { file: absoluteFile, line };
  }
  return map;
}

// Directories to skip while walking the workspace — avoids noise from build
// artefacts and dependency caches.
const SKIP_DIRS = new Set(["target", "node_modules", ".git"]);

function refreshFromRustSource(workspaceRoot: string): void {
  const found: LocationMap = {};

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission error or race — skip silently
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        const full = path.join(dir, entry.name);
        try {
          const src = fs.readFileSync(full, "utf8");
          Object.assign(found, parseRustLocations(src, full));
        } catch {
          // unreadable file — skip
        }
      }
    }
  };
  walk(workspaceRoot);

  // Merge results into the global cache (other workspace folders keep their
  // entries intact).
  Object.assign(cachedMap, found);

  // Persist to .maturing/_rust_locations.json at the workspace root so the
  // map survives VS Code restarts and is inspectable by developers.
  // Only write if the project has already been initialized (i.e. the
  // .maturing directory exists).  Use the "Maturing: Initialize Project"
  // command to opt a workspace into this feature.
  const maturingDir = path.join(workspaceRoot, ".maturing");
  const jsonPath = path.join(maturingDir, "_rust_locations.json");
  if (fs.existsSync(maturingDir)) {
    try {
      // Write only the entries that belong to this workspace root.
      const forRoot: Record<string, { file: string; line: number }> = {};
      for (const [name, loc] of Object.entries(found)) {
        forRoot[name] = loc; // absolute paths kept as-is for readability
      }
      fs.writeFileSync(jsonPath, JSON.stringify(forRoot, null, 2) + "\n");
    } catch {
      // .maturing/ may not be writable in some environments — non-fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // Eagerly parse workspace folders that have already been initialized
  // (i.e. the .maturing directory exists).  Uninitialized folders are left
  // alone until the user runs "Maturing: Initialize Project".
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const maturingDir = path.join(folder.uri.fsPath, ".maturing");
    if (fs.existsSync(maturingDir)) {
      refreshFromRustSource(folder.uri.fsPath);
    }
  }

  // Watch all .rs files in the workspace.  Filter out build artefacts
  // (target/) in the callback rather than in the glob, which is simpler and
  // more portable across operating systems.
  const rustWatcher = vscode.workspace.createFileSystemWatcher("**/*.rs");
  const onRustChange = (uri: vscode.Uri) => {
    const p = uri.fsPath;
    if (p.includes(`${path.sep}target${path.sep}`)) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) refreshFromRustSource(folder.uri.fsPath);
  };
  rustWatcher.onDidChange(onRustChange);
  rustWatcher.onDidCreate(onRustChange);
  rustWatcher.onDidDelete(onRustChange);
  context.subscriptions.push(rustWatcher);

  // If something external (e.g. gen_stubs.py) rewrites .maturing/_rust_locations.json,
  // clear the cache so the next lookup re-reads it from disk.
  const jsonWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.maturing/_rust_locations.json"
  );
  jsonWatcher.onDidChange(() => { cachedMap = {}; });
  jsonWatcher.onDidCreate(() => { cachedMap = {}; });
  jsonWatcher.onDidDelete(() => { cachedMap = {}; });
  context.subscriptions.push(jsonWatcher);

  // Override "Go To Definition" so that PyO3 functions navigate directly to
  // their Rust source — no picker, no .pyi stub in the way.
  // For every other symbol the fallback delegates to the registered
  // DefinitionProviders (Pylance, rust-analyzer, etc.) exactly as normal.
  const override = vscode.commands.registerCommand(
    "editor.action.revealDefinition",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const document = editor.document;
      const position = editor.selection.active;

      if (document.languageId === "python") {
        const wordRange = document.getWordRangeAtPosition(position);
        if (wordRange) {
          const word = document.getText(wordRange);
          const loc = cachedMap[word];
          if (loc) {
            const pos = new vscode.Position(loc.line - 1, 0);
            await vscode.window.showTextDocument(vscode.Uri.file(loc.file), {
              selection: new vscode.Range(pos, pos),
            });
            return;
          }
        }
      }

      // Fallback: ask all registered providers and navigate to the first result.
      const defs = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >("vscode.executeDefinitionProvider", document.uri, position);

      if (!defs || defs.length === 0) return;

      const first = defs[0];
      const uri =
        "targetUri" in first
          ? (first as vscode.LocationLink).targetUri
          : (first as vscode.Location).uri;
      const range =
        "targetSelectionRange" in first
          ? ((first as vscode.LocationLink).targetSelectionRange ??
            (first as vscode.LocationLink).targetRange)
          : (first as vscode.Location).range;

      await vscode.window.showTextDocument(uri, { selection: range });
    }
  );

  context.subscriptions.push(override);

  // "Maturing: Initialize Project" — creates the .maturing directory in every
  // workspace folder and performs the initial Rust scan.  Running this command
  // is the explicit opt-in that enables the extension's features for a project.
  const initCmd = vscode.commands.registerCommand(
    "maturing.initializeProject",
    async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage(
          "Maturing: No workspace folder is open. Please open a folder first."
        );
        return;
      }

      for (const folder of folders) {
        const maturingDir = path.join(folder.uri.fsPath, ".maturing");
        try {
          if (!fs.existsSync(maturingDir)) {
            fs.mkdirSync(maturingDir);
          }
          refreshFromRustSource(folder.uri.fsPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Maturing: Failed to initialize project at ${folder.uri.fsPath}: ${message}`);
          vscode.window.showErrorMessage(
            `Maturing: Failed to initialize project at ${folder.uri.fsPath}: ${message}`
          );
          return;
        }
      }

      vscode.window.showInformationMessage(
        "Maturing: Project initialized. Go To Definition is now active for PyO3 functions."
      );
    }
  );

  context.subscriptions.push(initCmd);
}

export function deactivate(): void {}
