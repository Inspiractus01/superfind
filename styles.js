const vscode = require('vscode');
const fs = require('fs');

// Built-in CSS/SCSS support has no workspace symbol provider, so style
// definitions are indexed here: classes (nested BEM resolved), ids,
// placeholders, mixins and variables.

const STYLE_GLOB = '**/*.{scss,css,less}';
const STYLE_EXT = new Set(['scss', 'css', 'less']);
const MARKUP_EXT = new Set(['tsx', 'jsx', 'ts', 'js', 'mjs', 'html', 'vue', 'svelte', 'astro', 'php', 'twig', 'hbs', 'njk', 'erb']);
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_SELECTORS = 200;

const styleIndex = new Map(); // fsPath -> { uri, rel, text, entries }
const textCache = new Map(); // fsPath -> text (markup files, read lazily)

const extOf = (path) => path.split('.').pop().toLowerCase();

// Splits on `sep` outside of (), [] and #{}.
function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === sep && depth === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function resolveSelector(selector, parents) {
  const parts = splitTopLevel(selector, ',');
  if (!parents.length) return parts.map((p) => p.replace(/&/g, ''));

  const out = [];
  for (const part of parts) {
    for (const parent of parents) {
      out.push(part.includes('&') ? part.replace(/&/g, parent) : `${parent} ${part}`);
      if (out.length >= MAX_SELECTORS) return out;
    }
  }
  return out;
}

// Only the last compound selector is "defined" by a rule: `.card .icon`
// defines `.icon`, `.card { &__title {} }` defines `.card__title`.
function lastCompound(selector) {
  let s = selector;
  let prev;
  do {
    prev = s;
    s = s.replace(/\([^()]*\)/g, '').replace(/\[[^\]]*\]/g, '');
  } while (s !== prev);
  const compounds = s.split(/[\s>+~]+/).filter(Boolean);
  return compounds[compounds.length - 1] || '';
}

function parseStyles(text) {
  const entries = [];
  const seen = new Set();
  const add = (kind, name, line, col) => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, name, line, col });
  };

  const stack = [];
  let buf = '';
  let bufLine = -1;
  let bufCol = 0;
  let line = 0;
  let lineStart = 0;

  const append = (i) => {
    const ch = text[i];
    if (bufLine === -1 && !/\s/.test(ch)) {
      bufLine = line;
      bufCol = i - lineStart;
    }
    buf += ch;
  };
  const newline = (i) => {
    line++;
    lineStart = i + 1;
  };
  const reset = () => {
    buf = '';
    bufLine = -1;
  };
  const collect = (selectors, selLine, selCol) => {
    for (const sel of selectors) {
      const compound = lastCompound(sel);
      for (const m of compound.matchAll(/([.#%])(-?[_a-zA-Z][\w-]*)/g)) {
        const next = compound[m.index + m[0].length];
        if (next === '#' || next === '\\') continue; // interpolated / escaped name
        const kind = m[1] === '.' ? 'class' : m[1] === '#' ? 'id' : 'placeholder';
        add(kind, m[2], selLine, selCol);
      }
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '\n') {
      newline(i);
      buf += ' ';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] === '\n') newline(i);
      i--;
    } else if (ch === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (ch === '"' || ch === "'") {
      append(i);
      for (i++; i < text.length && text[i] !== ch; i++) {
        if (text[i] === '\\') append(i++);
        if (text[i] === '\n') newline(i);
        append(i);
      }
      if (i < text.length) append(i);
    } else if (ch === '#' && text[i + 1] === '{') {
      let depth = 0;
      append(i++);
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        else if (text[i] === '\n') newline(i);
        append(i);
        if (depth === 0) break;
      }
    } else if (ch === ';') {
      reset();
    } else if (ch === '}') {
      stack.pop();
      reset();
    } else if (ch === '{') {
      const selector = buf.trim();
      const selLine = bufLine === -1 ? line : bufLine;
      const parents = stack.length ? stack[stack.length - 1] : [];
      let resolved;

      if (selector.startsWith('@')) {
        const mixin = /^@mixin\s+([\w-]+)/.exec(selector);
        const atRoot = /^@at-root\b\s*(.*)$/.exec(selector);
        if (mixin) {
          add('mixin', mixin[1], selLine, bufCol);
          resolved = [];
        } else if (atRoot) {
          const rest = atRoot[1];
          resolved = rest ? resolveSelector(rest, rest.includes('&') ? parents : []) : parents;
          if (rest) collect(resolved, selLine, bufCol);
        } else if (/^@(function|keyframes|font-face)\b/.test(selector)) {
          resolved = [];
        } else {
          resolved = parents; // @media, @include … {}, @supports, …
        }
      } else if (/^[\w-]+\s*:$/.test(selector)) {
        resolved = parents; // nested property: `font: { … }`
      } else {
        resolved = resolveSelector(selector, parents);
        collect(resolved, selLine, bufCol);
      }

      stack.push(resolved);
      reset();
    } else {
      append(i);
    }
  }

  const lines = text.split('\n');
  for (let l = 0; l < lines.length; l++) {
    for (const m of lines[l].matchAll(/(^|[\s{;])(\$[\w-]+|--[\w-]+)\s*:/g)) {
      add('variable', m[2], l, m.index + m[1].length);
    }
  }

  return entries;
}

async function readText(uri) {
  const stat = await fs.promises.stat(uri.fsPath);
  if (stat.size > MAX_FILE_SIZE) return null;
  return fs.promises.readFile(uri.fsPath, 'utf8');
}

async function indexStyleFile(uri) {
  try {
    const text = await readText(uri);
    if (text === null) return;
    styleIndex.set(uri.fsPath, {
      uri,
      rel: vscode.workspace.asRelativePath(uri, false),
      text,
      entries: parseStyles(text),
    });
  } catch {
    styleIndex.delete(uri.fsPath);
  }
}

async function buildStyleIndex(exclude) {
  const uris = await vscode.workspace.findFiles(STYLE_GLOB, exclude, 5000);
  styleIndex.clear();
  await Promise.all(uris.map(indexStyleFile));
}

function invalidate(uri) {
  textCache.delete(uri.fsPath);
  if (STYLE_EXT.has(extOf(uri.fsPath))) indexStyleFile(uri);
}

async function cachedText(uri) {
  if (textCache.has(uri.fsPath)) return textCache.get(uri.fsPath);
  let text = null;
  try {
    text = await readText(uri);
  } catch {
    // unreadable, cache the miss
  }
  textCache.set(uri.fsPath, text);
  return text;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function displayName({ kind, name }) {
  if (kind === 'class') return `.${name}`;
  if (kind === 'id') return `#${name}`;
  if (kind === 'placeholder') return `%${name}`;
  if (kind === 'mixin') return `@mixin ${name}`;
  return name;
}

const KIND_ICON = {
  class: '$(symbol-class)',
  id: '$(symbol-key)',
  placeholder: '$(symbol-misc)',
  mixin: '$(symbol-method)',
  variable: '$(symbol-variable)',
};

// Where to look for usages of a definition, and what a usage looks like.
function usagePattern({ kind, name }) {
  const n = escapeRegex(name);
  if (kind === 'class' || kind === 'id') return { markup: true, regex: new RegExp(`(?<![\\w-])${n}(?![\\w-])`) };
  if (kind === 'mixin') return { markup: false, regex: new RegExp(`@include\\s+${n}(?![\\w-])`) };
  if (kind === 'placeholder') return { markup: false, regex: new RegExp(`@extend\\s+%${n}(?![\\w-])`) };
  return { markup: false, regex: new RegExp(`${n}(?![\\w-])`) };
}

function matchLines(text, regex, skip) {
  const hits = [];
  const lines = text.split('\n');
  for (let l = 0; l < lines.length; l++) {
    if (skip && skip(l)) continue;
    const m = regex.exec(lines[l]);
    if (m) hits.push({ line: l, col: m.index, text: lines[l] });
  }
  return hits;
}

async function findUsages(def, fileCache) {
  const { markup, regex } = usagePattern(def);
  const usages = [];

  if (markup) {
    const targets = (fileCache || []).filter((f) => MARKUP_EXT.has(extOf(f.path)));
    const texts = await Promise.all(targets.map((f) => cachedText(f.uri)));
    targets.forEach((f, i) => {
      if (!texts[i]) return;
      for (const hit of matchLines(texts[i], regex)) usages.push({ uri: f.uri, rel: f.path, ...hit });
    });
  } else {
    for (const file of styleIndex.values()) {
      const isDefFile = file.uri.fsPath === def.uri.fsPath;
      for (const hit of matchLines(file.text, regex, isDefFile ? (l) => l === def.line : null)) {
        usages.push({ uri: file.uri, rel: file.rel, ...hit });
      }
    }
  }
  return usages;
}

function nameScore(query, name, fuzzyScore) {
  const q = query.toLowerCase();
  const idx = name.toLowerCase().indexOf(q);
  if (idx !== -1) return idx * 0.1 + (name.length - q.length) * 0.01; // substring beats fuzzy
  const fuzzy = fuzzyScore(q, name);
  return fuzzy === null ? null : 100 + fuzzy;
}

async function searchStyles(query, fuzzyScore, fileCache) {
  let q = query;
  let kindFilter = null;
  const prefix = /^(\.|#|%|@mixin\s+)(?=[\w-])/.exec(q);
  if (prefix) {
    kindFilter = { '.': 'class', '#': 'id', '%': 'placeholder' }[prefix[1]] || 'mixin';
    q = q.slice(prefix[0].length);
  }
  if (q.length < 2) return [];

  const scored = [];
  for (const file of styleIndex.values()) {
    for (const entry of file.entries) {
      if (kindFilter && entry.kind !== kindFilter) continue;
      const score = nameScore(q, entry.name, fuzzyScore);
      if (score !== null) scored.push({ ...entry, uri: file.uri, rel: file.rel, score });
    }
  }
  if (!scored.length) return [];
  scored.sort((a, b) => a.score - b.score);

  const top = scored.slice(0, 20);
  const items = [{ label: 'Styles', kind: vscode.QuickPickItemKind.Separator }];
  for (const def of top) {
    items.push({
      label: `${KIND_ICON[def.kind]} ${displayName(def)}`,
      description: `${def.rel}:${def.line + 1}`,
      _type: 'symbol',
      _location: new vscode.Location(def.uri, new vscode.Position(def.line, def.col)),
    });
  }

  // Usages only for the best few matches, it reads file contents.
  const usageLists = await Promise.all(top.slice(0, 5).map((def) => findUsages(def, fileCache).then((u) => ({ def, u }))));
  const usageItems = [];
  for (const { def, u } of usageLists) {
    for (const hit of u) {
      usageItems.push({
        label: `$(references) ${displayName(def)}`,
        description: `${hit.rel}:${hit.line + 1}`,
        detail: hit.text.trim().slice(0, 100),
        _type: 'symbol',
        _location: new vscode.Location(hit.uri, new vscode.Position(hit.line, hit.col)),
      });
    }
  }
  if (usageItems.length) {
    items.push({ label: 'Style usages', kind: vscode.QuickPickItemKind.Separator });
    items.push(...usageItems.slice(0, 40));
  }

  return items;
}

module.exports = { buildStyleIndex, invalidate, searchStyles, parseStyles };
