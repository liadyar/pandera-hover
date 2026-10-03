'use strict';

// Pulls the field list out of a Python class's source (a pandera DataFrameModel,
// or anything else declared as `name: annotation [= default]`). Pure text parsing,
// no Python involved, so it sees unsaved edits and never runs project code.
// Kept free of `vscode` imports so it can be tested with plain node.

const HEADER = /^(\s*)class\s+(\w+)\s*(?:\((.*)\))?\s*:/;

function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

// Strips a trailing `#` comment and returns the line's net bracket depth change,
// ignoring anything inside string literals.
function scan(text) {
  let quote = null;
  let delta = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return { code: text.slice(0, i), delta };
    else if ('([{'.includes(ch)) delta++;
    else if (')]}'.includes(ch)) delta--;
  }
  return { code: text, delta };
}

// Splits `Series[str] = pa.Field(nullable=True)` at the top-level `=` into
// [annotation, default]; default is undefined when there is none.
function splitDefault(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === '=' && depth === 0 && text[i + 1] !== '=' && !'=<>!'.includes(text[i - 1])) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  return [text.trim(), undefined];
}

// Parses the class whose header is at `lines[start]`.
// Returns { name, bases, fields: [{ name, annotation, default }] } or null.
function parseClass(lines, start) {
  const header = lines[start].match(HEADER);
  if (!header) return null;
  const classIndent = header[1].length;
  const bases = (header[3] || '').split(',').map((b) => b.trim()).filter(Boolean);
  const fields = [];
  let bodyIndent = null;
  let openString = null; // closing quotes of a multi-line string being skipped

  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (openString) {
      if (raw.includes(openString)) openString = null;
      continue;
    }
    if (!raw.trim()) continue;
    const indent = indentOf(raw);
    if (indent <= classIndent) break;
    if (bodyIndent === null) bodyIndent = indent;
    // Deeper lines belong to nested blocks (`class Config:`, methods).
    if (indent !== bodyIndent) continue;

    const line = raw.trim();
    const str = line.match(/^[rRbBuUfF]*("""|''')/);
    if (str) {
      if (!line.slice(str[0].length).includes(str[1])) openString = str[1];
      continue;
    }
    const field = line.match(/^(\w+)\s*:(.*)$/);
    if (!field) continue;

    // An annotation or Field(...) call can wrap onto following lines.
    let { code, delta } = scan(field[2]);
    while (delta > 0 && i + 1 < lines.length) {
      const next = scan(lines[++i]);
      code += ' ' + next.code.trim();
      delta += next.delta;
    }
    const [annotation, dflt] = splitDefault(code.trim());
    fields.push({ name: field[1], annotation, default: dflt });
  }
  return { name: header[2], bases, fields };
}

// Index of the header line of `class <name>`, searching from `from` (or -1).
function findClassLine(lines, name, from = 0) {
  const re = new RegExp(`^\\s*class\\s+${name}\\b`);
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

// `pa.Field(nullable=True)` -> `nullable=True`; any other default -> `= <default>`.
function describeDefault(dflt) {
  if (dflt === undefined) return '';
  const call = dflt.match(/^(?:[\w.]+\.)?Field\(([\s\S]*)\)$/);
  if (call) return call[1].trim();
  return `= ${dflt}`;
}

// Renders fields as aligned Python-ish lines for a ```python hover block.
function formatFields(fields) {
  if (!fields.length) return '# (no fields)';
  const width = Math.max(...fields.map((f) => f.name.length));
  return fields
    .map((f) => {
      const extra = describeDefault(f.default);
      return `${f.name.padEnd(width)}: ${f.annotation}${extra ? `  # ${extra}` : ''}`;
    })
    .join('\n');
}

module.exports = { parseClass, findClassLine, formatFields, splitDefault, scan };
