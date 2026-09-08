const vscode = require('vscode');
const fs = require('fs');

const EXCLUDE = '**/{node_modules,graft,.next,dist,build,.git}/**';
const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'woff', 'woff2', 'ttf', 'eot', 'pdf', 'zip', 'lock']);

let fileCache = null; // { uri, path }[]
let folderCache = null; // { path }[]

async function buildFileFolderCache() {
  const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, 20000);
  const folders = new Set();
  const files = [];

  for (const uri of uris) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    files.push({ uri, path: rel });

    const parts = rel.split('/');
    parts.pop();
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      folders.add(acc);
    }
  }

  fileCache = files;
  folderCache = [...folders].map((path) => ({ path }));
}

// Simple subsequence fuzzy match: every query char must appear in order.
// Returns a score (lower = better) or null if it doesn't match at all.
function fuzzyScore(query, target) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstMatch === -1) firstMatch = ti;
      lastMatch = ti;
      qi++;
    }
  }

  if (qi < q.length) return null; // not all query chars found in order
  return lastMatch - firstMatch + firstMatch * 0.1; // tighter + earlier match wins
}

function symbolKindIcon(kind) {
  const map = {
    [vscode.SymbolKind.Class]: '$(symbol-class)',
    [vscode.SymbolKind.Function]: '$(symbol-method)',
    [vscode.SymbolKind.Method]: '$(symbol-method)',
    [vscode.SymbolKind.Interface]: '$(symbol-interface)',
    [vscode.SymbolKind.Variable]: '$(symbol-variable)',
    [vscode.SymbolKind.Constant]: '$(symbol-constant)',
    [vscode.SymbolKind.Enum]: '$(symbol-enum)',
    [vscode.SymbolKind.Struct]: '$(symbol-struct)',
  };
  return map[kind] || '$(symbol-misc)';
}

async function search(query) {
  const items = [];

  if (query.length >= 2) {
    try {
      const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query);
      if (symbols && symbols.length) {
        const topSymbols = symbols.slice(0, 15);
        items.push({ label: 'Symbols', kind: vscode.QuickPickItemKind.Separator });
        for (const sym of topSymbols) {
          items.push({
            label: `${symbolKindIcon(sym.kind)} ${sym.name}`,
            description: vscode.workspace.asRelativePath(sym.location.uri, false),
            _type: 'symbol',
            _location: sym.location,
          });
        }

        const usageLists = await Promise.all(
          topSymbols.map((sym) =>
            vscode.commands
              .executeCommand('vscode.executeReferenceProvider', sym.location.uri, sym.location.range.start)
              .then((refs) => ({ sym, refs: refs || [] }))
              .catch(() => ({ sym, refs: [] })),
          ),
        );

        const usageItems = [];
        for (const { sym, refs } of usageLists) {
          for (const ref of refs) {
            const isDefinitionItself =
              ref.uri.toString() === sym.location.uri.toString() && ref.range.start.line === sym.location.range.start.line;
            if (isDefinitionItself) continue;

            usageItems.push({
              label: `$(references) ${sym.name}`,
              description: `${vscode.workspace.asRelativePath(ref.uri, false)}:${ref.range.start.line + 1}`,
              _type: 'symbol',
              _location: ref,
            });
          }
        }

        if (usageItems.length) {
          items.push({ label: 'Usages', kind: vscode.QuickPickItemKind.Separator });
          items.push(...usageItems.slice(0, 40));
        }
      }
    } catch {
      // no workspace symbol provider active for this query, ignore
    }
  }

  if (fileCache) {
    const scoredFiles = [];
    for (const f of fileCache) {
      const score = fuzzyScore(query, f.path);
      if (score !== null) scoredFiles.push({ f, score });
    }
    scoredFiles.sort((a, b) => a.score - b.score);
    if (scoredFiles.length) {
      items.push({ label: 'Files', kind: vscode.QuickPickItemKind.Separator });
      for (const { f } of scoredFiles.slice(0, 30)) {
        items.push({ label: `$(file) ${f.path}`, _type: 'file', _uri: f.uri });
      }
    }
  }

  if (folderCache) {
    const scoredFolders = [];
    for (const f of folderCache) {
      const score = fuzzyScore(query, f.path);
      if (score !== null) scoredFolders.push({ f, score });
    }
    scoredFolders.sort((a, b) => a.score - b.score);
    if (scoredFolders.length) {
      items.push({ label: 'Folders', kind: vscode.QuickPickItemKind.Separator });
      for (const { f } of scoredFolders.slice(0, 15)) {
        items.push({ label: `$(folder) ${f.path}`, _type: 'folder', _path: f.path });
      }
    }
  }

  return items;
}

// Fallback only: literal content search across cached files. Slower (reads
// file bodies), so it only runs when nothing matched by name.
function searchContent(query) {
  if (!fileCache || query.length < 3) return [];
  const needle = query.toLowerCase();
  const items = [];

  for (const f of fileCache) {
    if (items.length >= 30) break;
    const ext = f.path.split('.').pop().toLowerCase();
    if (BINARY_EXT.has(ext)) continue;

    let text;
    try {
      text = fs.readFileSync(f.uri.fsPath, 'utf8');
    } catch {
      continue;
    }
    if (!text.toLowerCase().includes(needle)) continue;

    const lines = text.split('\n');
    const lineIndex = lines.findIndex((l) => l.toLowerCase().includes(needle));
    if (lineIndex === -1) continue;

    items.push({
      label: `$(search) ${lines[lineIndex].trim().slice(0, 80)}`,
      description: `${f.path}:${lineIndex + 1}`,
      _type: 'content',
      _uri: f.uri,
      _line: lineIndex,
    });
  }

  if (!items.length) return [];
  return [{ label: 'Content matches', kind: vscode.QuickPickItemKind.Separator }, ...items];
}

function openSuperFind() {
  const qp = vscode.window.createQuickPick();
  qp.placeholder = 'Search files, symbols (classes/functions), and folders…';
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;

  let debounceTimer;
  let requestId = 0;
  qp.onDidChangeValue((value) => {
    clearTimeout(debounceTimer);
    const query = value.trim();
    const myRequest = ++requestId;

    debounceTimer = setTimeout(async () => {
      const nameResults = await search(query);
      if (myRequest !== requestId) return;

      if (nameResults.length) {
        qp.items = nameResults;
        return;
      }

      // Nothing by name -> fall back to content search (slower).
      qp.busy = true;
      const contentResults = searchContent(query);
      if (myRequest === requestId) {
        qp.items = contentResults;
        qp.busy = false;
      }
    }, 80);
  });

  qp.onDidAccept(async () => {
    const [item] = qp.selectedItems;
    if (!item) return;
    qp.hide();

    if (item._type === 'file') {
      const doc = await vscode.workspace.openTextDocument(item._uri);
      await vscode.window.showTextDocument(doc);
    } else if (item._type === 'symbol') {
      const doc = await vscode.workspace.openTextDocument(item._location.uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.revealRange(item._location.range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(item._location.range.start, item._location.range.start);
    } else if (item._type === 'folder') {
      const folderUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, item._path);
      await vscode.commands.executeCommand('revealInExplorer', folderUri);
    } else if (item._type === 'content') {
      const doc = await vscode.workspace.openTextDocument(item._uri);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(item._line, 0);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(pos, pos);
    }
  });

  qp.items = [];
  qp.show();
}

function activate(context) {
  buildFileFolderCache();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  let rebuildTimer;
  const scheduleRebuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(buildFileFolderCache, 500);
  };
  watcher.onDidCreate(scheduleRebuild);
  watcher.onDidDelete(scheduleRebuild);

  context.subscriptions.push(watcher, vscode.commands.registerCommand('superfind.open', openSuperFind));
}

function deactivate() {}

module.exports = { activate, deactivate };
