'use strict';

// Adds a pandera schema's columns to the Python hover. When the Python language
// server's hover for a symbol mentions `DataFrame[SomeSchema]`, this finds
// `class SomeSchema`, reads its fields straight from the source and shows them
// under the language server's text.

const vscode = require('vscode');
const { parseClass, findClassLine, formatFields } = require('./schemaParser');

const FRAME_TYPE = /\b(?:DataFrame|GeoDataFrame|LazyFrame)\[\s*([\w.]+)\s*\]/g;
// Base classes that end the inheritance walk (their own fields aren't columns).
const ROOT_BASES = new Set(['DataFrameModel', 'SchemaModel', 'BaseModel']);
// Type arguments that are never a schema class, so not worth looking up.
const NOT_SCHEMAS = new Set(['Any', 'object']);
// Library code: only used when no workspace class of that name exists.
const LIBRARY_PATH = /[\\/](venv|\.venv|node_modules|site-packages)[\\/]/;
const MAX_BASE_DEPTH = 5;
const MISS_TTL_MS = 30_000;

// Hover requests we are currently answering by asking every provider (including
// this one) for its hover; the nested call to ourselves must return nothing.
const inFlight = new Set();
// schema name -> { uri, line } of its `class` header, re-checked before use.
const locations = new Map();
// schema name -> time it was last not found, so misses don't rescan every hover.
const misses = new Map();

function excludeGlob() {
  const globs = vscode.workspace.getConfiguration('panderaHover').get('exclude', []);
  return globs.length ? `{${globs.join(',')}}` : undefined;
}

function hoverText(hovers) {
  return (hovers || [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
}

// Workspace symbol hits for `class <name>`, best first: the hovered file, then
// the workspace, then library code.
async function locateBySymbols(name, fromUri) {
  let symbols;
  try {
    symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name);
  } catch {
    return [];
  }
  const rank = (uri) => {
    if (uri.toString() === fromUri.toString()) return 0;
    if (LIBRARY_PATH.test(uri.fsPath)) return 2;
    return 1;
  };
  return (symbols || [])
    .filter((s) => s.name === name && s.kind === vscode.SymbolKind.Class)
    .map((s) => ({ uri: s.location.uri, line: s.location.range.start.line }))
    .sort((a, b) => rank(a.uri) - rank(b.uri));
}

async function locateByScanning(name) {
  const header = new RegExp(`^[ \\t]*class[ \\t]+${name}\\b`, 'm');
  const files = await vscode.workspace.findFiles('**/*.py', excludeGlob());
  for (const uri of files) {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const match = header.exec(text);
    if (match) return { uri, line: text.slice(0, match.index).split('\n').length - 1 };
  }
  return undefined;
}

async function readClassAt(loc, name) {
  const doc = await vscode.workspace.openTextDocument(loc.uri);
  const lines = doc.getText().split(/\r?\n/);
  // Symbol ranges can start at a decorator, and cached lines go stale on edits.
  const line = findClassLine(lines, name, loc.line - 1);
  return line === -1 ? undefined : { uri: loc.uri, lines, line };
}

// Returns { uri, lines, line } for `class <name>`, or undefined if it can't be found.
async function findClass(name, fromUri) {
  const missedAt = misses.get(name);
  if (missedAt && Date.now() - missedAt < MISS_TTL_MS) return undefined;

  const candidates = [locations.get(name), ...(await locateBySymbols(name, fromUri))];
  for (const loc of candidates) {
    if (!loc) continue;
    const found = await readClassAt(loc, name);
    if (found) {
      locations.set(name, { uri: found.uri, line: found.line });
      return found;
    }
  }

  const scanned = await locateByScanning(name);
  const found = scanned && (await readClassAt(scanned, name));
  if (!found) {
    misses.set(name, Date.now());
    return undefined;
  }
  misses.delete(name);
  locations.set(name, { uri: found.uri, line: found.line });
  return found;
}

// Fields of `name`, with inherited schema fields first (a subclass overrides by name).
async function collectFields(name, fromUri, depth = 0) {
  const found = await findClass(name, fromUri);
  if (!found) return undefined;
  const cls = parseClass(found.lines, found.line);
  if (!cls) return undefined;

  const byName = new Map();
  if (depth < MAX_BASE_DEPTH) {
    for (const base of cls.bases) {
      const baseName = base.split('.').pop().replace(/\[.*$/, '');
      if (ROOT_BASES.has(baseName)) continue;
      const inherited = await collectFields(baseName, found.uri, depth + 1);
      for (const f of inherited?.fields || []) byName.set(f.name, f);
    }
  }
  for (const f of cls.fields) byName.set(f.name, f);
  return { fields: [...byName.values()], uri: found.uri, line: found.line };
}

async function provideHover(document, position, token) {
  const key = `${document.uri.toString()}:${position.line}:${position.character}`;
  if (inFlight.has(key)) return undefined;

  inFlight.add(key);
  let text;
  try {
    text = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position));
  } finally {
    inFlight.delete(key);
  }

  const names = [...new Set([...text.matchAll(FRAME_TYPE)].map((m) => m[1].split('.').pop()))]
    .filter((name) => !NOT_SCHEMAS.has(name));
  if (!names.length || token.isCancellationRequested) return undefined;

  const md = new vscode.MarkdownString();
  for (const name of names) {
    const schema = await collectFields(name, document.uri);
    if (token.isCancellationRequested) return undefined;
    if (!schema) continue;
    const target = schema.uri.with({ fragment: `L${schema.line + 1}` });
    const file = vscode.workspace.asRelativePath(schema.uri);
    md.appendMarkdown(`**${name}** — [${file}:${schema.line + 1}](${target.toString()})\n`);
    md.appendCodeblock(formatFields(schema.fields), 'python');
  }
  return md.value ? new vscode.Hover(md) : undefined;
}

function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: 'python' }, { provideHover }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
