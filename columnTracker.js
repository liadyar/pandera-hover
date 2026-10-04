'use strict';

// Follows one DataFrame variable through the statements before a hover and works
// out how its columns change on the way: `df = df.drop(columns=[...])`,
// `df["new"] = ...`, `df.rename(columns={...})`, Polars `select`/`with_columns`
// and so on. Like schemaParser it only reads source text, so it never runs code;
// anything it can't resolve from literals is reported as a note, not guessed.
// Kept free of `vscode` imports so it can be tested with plain node.

const { describeDefault } = require('./schemaParser');

const OPEN = '([{';
const CLOSE = ')]}';

// Methods that keep the frame's columns as they are (row filters, sorts, casts...).
const PRESERVE = new Set([
  'abs', 'applymap', 'asfreq', 'astype', 'bfill', 'cache', 'cast', 'clip', 'clone', 'collect',
  'convert_dtypes', 'copy', 'cummax', 'cummin', 'cumprod', 'cumsum', 'diff', 'drop_duplicates',
  'drop_nans', 'drop_nulls', 'dropna', 'explode', 'ffill', 'fill_nan', 'fill_null', 'fillna',
  'head', 'infer_objects', 'interpolate', 'isna', 'isnull', 'lazy', 'limit', 'map', 'mask',
  'nlargest', 'notna', 'notnull', 'nsmallest', 'pct_change', 'query', 'rank', 'rechunk',
  'replace', 'round', 'sample', 'shift', 'shrink_to_fit', 'slice', 'sort', 'sort_index',
  'sort_values', 'tail', 'to_pandas', 'to_polars', 'tz_convert', 'tz_localize', 'unique', 'where',
]);
// Methods whose result has unrelated columns, or isn't this frame at all.
const RESHAPE = new Set([
  'agg', 'aggregate', 'all', 'any', 'apply', 'corr', 'count', 'cov', 'describe', 'ewm',
  'expanding', 'get_column', 'get_dummies', 'group_by', 'groupby', 'iterrows', 'itertuples',
  'max', 'mean', 'median', 'melt', 'min', 'null_count', 'nunique', 'pivot', 'pivot_table',
  'prod', 'quantile', 'resample', 'rolling', 'stack', 'std', 'sum', 'to_dict', 'to_dummies',
  'to_list', 'to_numpy', 'to_series', 'transpose', 'unpivot', 'unstack', 'value_counts', 'var',
]);
const SCOPE = /^(?:async\s+)?(?:def|class)\b/;
// Block headers whose body always runs once the block is reached.
const TRANSPARENT = /^(?:async\s+)?(?:with|try|finally)\b/;
const RESET = { kind: 'reset' };

// ---------------------------------------------------------------- lexing helpers

// Index of the last character of the string literal that starts at text[i].
function skipString(text, i) {
  const quote = text[i];
  const close = text.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
  for (let j = i + close.length; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (close.length === 1 && text[j] === '\n') return j - 1;
    else if (text.startsWith(close, j)) return j + close.length - 1;
  }
  return text.length - 1;
}

// Index of the bracket that closes the one at text[i], or -1.
function matchBracket(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"' || ch === "'") j = skipString(text, j);
    else if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch) && --depth === 0) return j;
  }
  return -1;
}

// Splits at characters outside brackets and strings for which `isSep(text, i)` holds.
function splitTop(text, isSep) {
  const test = typeof isSep === 'string' ? (t, i) => t[i] === isSep : isSep;
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") i = skipString(text, i);
    else if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth--;
    else if (depth === 0 && test(text, i)) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

// `a = b = value` -> ['a ', ' b ', ' value']; leaves `==`, `+=`, `:=`, `<=`... alone.
function splitAssign(text) {
  return splitTop(text, (t, i) => t[i] === '=' && t[i + 1] !== '=' && !'=!<>:+-*/%@&|^'.includes(t[i - 1]));
}

// Same length as `text`, with every string literal blanked out, for regex searches.
function maskStrings(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' || text[i] === "'") {
      const end = skipString(text, i);
      out += ' '.repeat(end - i + 1);
      i = end;
    } else {
      out += text[i];
    }
  }
  return out;
}

const STRING = /^[rRuU]?(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")$/;

// `"a"` -> 'a'; anything that isn't a plain string literal -> null.
function parseString(code) {
  const m = code.trim().match(STRING);
  return m ? (m[1] ?? m[2]).replace(/\\(.)/g, '$1') : null;
}

// `"a"`, `["a", "b"]`, `("a",)` -> names; anything non-literal -> null.
function parseStringList(code) {
  const c = code.trim();
  const single = parseString(c);
  if (single !== null) return [single];
  if (!c || !OPEN.includes(c[0]) || matchBracket(c, 0) !== c.length - 1) return null;
  const names = splitTop(c.slice(1, -1), ',').filter((s) => s.trim()).map(parseString);
  return names.includes(null) ? null : names;
}

// `{"a": "b"}` or `dict(a="b")` -> [['a', 'b']]; anything non-literal -> null.
function parseStringDict(code) {
  const c = code.trim();
  if (c.startsWith('{') && matchBracket(c, 0) === c.length - 1) {
    const pairs = [];
    for (const item of splitTop(c.slice(1, -1), ',')) {
      if (!item.trim()) continue;
      const kv = splitTop(item, ':');
      const pair = kv.length === 2 ? kv.map(parseString) : [null];
      if (pair.includes(null)) return null;
      pairs.push(pair);
    }
    return pairs;
  }
  const call = c.match(/^dict\s*\(/);
  if (call && matchBracket(c, call[0].length - 1) === c.length - 1) {
    const args = parseArgs(c.slice(call[0].length, -1));
    if (args.positional.length || args.starred) return null;
    const pairs = [...args.kwargs].map(([k, v]) => [k, parseString(v)]);
    return pairs.some(([, v]) => v === null) ? null : pairs;
  }
  return null;
}

function parseArgs(body) {
  const positional = [];
  const kwargs = new Map();
  let starred = false;
  for (const part of splitTop(body, ',')) {
    const p = part.trim();
    if (!p) continue;
    const kw = p.match(/^(\w+)\s*=(?!=)([\s\S]*)$/);
    if (p.startsWith('*')) starred = true;
    else if (kw) kwargs.set(kw[1], kw[2].trim());
    else positional.push(p);
  }
  return { positional, kwargs, starred };
}

// `df.drop(...)["a"].loc[...]` -> trailers after `name`, plus any unparsed rest.
// Returns null when the expression doesn't start with `name`.
function parseChain(expr, name) {
  let s = expr.trim();
  while (s.startsWith('(') && matchBracket(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
  if (!s.startsWith(name) || /\w/.test(s[name.length] ?? '')) return null;
  const trailers = [];
  let i = name.length;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === '.') {
      const m = /^\.\s*(\w+)/.exec(s.slice(i));
      if (!m) break;
      trailers.push({ type: 'attr', name: m[1] });
      i += m[0].length;
    } else if (s[i] === '(' || s[i] === '[') {
      const close = matchBracket(s, i);
      if (close === -1) break;
      trailers.push({ type: s[i] === '(' ? 'call' : 'index', body: s.slice(i + 1, close) });
      i = close + 1;
    } else {
      break;
    }
  }
  return { trailers, rest: s.slice(i).trim() };
}

// `a, (b, *c)` -> ['a', 'b', 'c'].
function targetNames(target) {
  return target.replace(/[()[\]]/g, '').split(',').map((s) => s.trim().replace(/^\*/, ''));
}

function short(code) {
  const s = code.replace(/\s+/g, ' ').trim();
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

// ---------------------------------------------------------------- statements

// Splits source lines into logical statements: { start, end, indent, text, parent },
// where text has comments removed and continuation lines joined, and parent is
// the index of the enclosing block's header statement (or -1).
function splitStatements(lines) {
  const stmts = [];
  let cur = null;
  let depth = 0;
  let openString = null; // closing quotes of a triple-quoted string spanning lines
  const finish = () => {
    stmts.push({ start: cur.start, end: cur.end, indent: cur.indent, text: cur.code.trim() });
    cur = null;
    depth = 0;
  };

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    let i = 0;
    if (openString) {
      const close = raw.indexOf(openString);
      cur.end = n;
      if (close === -1) {
        cur.code += ` ${raw}`;
        continue;
      }
      cur.code += ` ${raw.slice(0, close + 3)}`;
      i = close + 3;
      openString = null;
    } else {
      const indent = raw.search(/\S/);
      if (indent === -1 || raw[indent] === '#') continue;
      // An unclosed bracket (mid-edit) shouldn't swallow the rest of the file.
      if (cur && depth > 0 && indent <= cur.indent && !CLOSE.includes(raw[indent])) finish();
      if (cur) cur.code += ' ';
      else cur = { start: n, indent, code: '' };
      i = indent;
    }

    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        const triple = ch.repeat(3);
        if (raw.startsWith(triple, i)) {
          const end = raw.indexOf(triple, i + 3);
          if (end === -1) {
            cur.code += raw.slice(i);
            openString = triple;
            break;
          }
          cur.code += raw.slice(i, end + 3);
          i = end + 2;
        } else {
          const end = skipString(raw, i);
          cur.code += raw.slice(i, end + 1);
          i = end;
        }
        continue;
      }
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
      cur.code += ch;
    }
    cur.end = n;
    if (openString || depth > 0) continue;
    if (/\\\s*$/.test(cur.code)) {
      cur.code = cur.code.replace(/\\\s*$/, '');
      continue;
    }
    finish();
  }
  if (cur) finish();

  const stack = [];
  for (let k = 0; k < stmts.length; k++) {
    while (stack.length && stmts[stack[stack.length - 1]].indent >= stmts[k].indent) stack.pop();
    stmts[k].parent = stack.length ? stack[stack.length - 1] : -1;
    stack.push(k);
  }
  return stmts;
}

// Enclosing header statements of stmts[k], innermost first.
function ancestors(stmts, k) {
  const out = [];
  for (let p = stmts[k].parent; p !== -1; p = stmts[p].parent) out.push(p);
  return out;
}

const keyword = (stmt) => stmt.text.match(/^\w+/)?.[0];

// True when branch headers a and b (a before b) can't both run: `if`/`elif`/`else`
// arms of one chain, `case` arms of one `match`, or `except` arms of one `try`.
function exclusive(stmts, a, b) {
  if (a > b || stmts[a].parent !== stmts[b].parent) return false;
  const next = { if: ['elif', 'else'], elif: ['elif', 'else'], case: ['case'], except: ['except', 'else'] };
  if (!next[keyword(stmts[a])]?.includes(keyword(stmts[b]))) return false;
  for (let c = a + 1; c < b; c++) {
    if (stmts[c].parent === stmts[a].parent && !/^(?:elif|else|except|case)\b/.test(stmts[c].text)) return false;
  }
  return true;
}

// Whether statement k runs before the hovered statement h: 'always', 'maybe'
// (inside a branch or loop h isn't in) or 'never' (a nested function, or an
// arm of the same `if` chain).
function reaches(stmts, k, h, scope) {
  const path = (i) => ancestors(stmts, i).filter((a) => scope === undefined || a > scope).reverse();
  const own = path(k);
  const hovered = path(h);
  let i = 0;
  while (i < own.length && i < hovered.length && own[i] === hovered[i]) i++;
  const rest = own.slice(i);
  if (!rest.length) return 'always';
  if (rest.some((a) => SCOPE.test(stmts[a].text))) return 'never';
  if (exclusive(stmts, rest[0], hovered[i] ?? h)) return 'never';
  return rest.every((a) => TRANSPARENT.test(stmts[a].text)) ? 'always' : 'maybe';
}

// ---------------------------------------------------------------- column operations

const unknown = (text) => ({ kind: 'unknown', text });

function namesOp(kind, expr) {
  const names = expr === undefined ? null : parseStringList(expr);
  if (names) return { kind, names };
  const verb = { drop: 'drops', add: 'adds', keep: 'keeps only' }[kind];
  return unknown(`${verb} columns from \`${short(expr ?? '…')}\``);
}

const isColumnsAxis = (v) => v !== undefined && /^(?:1|(['"])columns\1)$/.test(v.trim());
const isRowsAxis = (v) => v !== undefined && /^(?:0|(['"])index\1)$/.test(v.trim());

// Names `col("x")`, `pl.lit(1).alias("y")`, `"z"` etc. would get in a Polars
// select/with_columns, or null when it can't be told from the text.
function outputName(expr) {
  const e = expr.trim();
  const literal = parseString(e);
  if (literal !== null) return literal;
  const masked = maskStrings(e);
  if (/\.\s*name\s*\./.test(masked)) return null;
  const depthAt = (i) => [...masked.slice(0, i)].reduce((d, ch) => d + OPEN.includes(ch) - CLOSE.includes(ch), 0);
  let alias;
  for (const m of masked.matchAll(/\.\s*alias\s*\(/g)) {
    if (depthAt(m.index) !== 0) continue;
    const open = m.index + m[0].length - 1;
    alias = parseString(e.slice(open + 1, matchBracket(e, open)));
  }
  if (alias !== undefined) return alias;
  const col = /(?<![\w.])(?:pl\s*\.\s*)?col\s*\(/.exec(masked);
  if (!col) return null;
  const open = col.index + col[0].length - 1;
  const name = parseString(e.slice(open + 1, matchBracket(e, open)));
  return name !== null && !/^\^|\*/.test(name) ? name : null;
}

// Polars `select(...)` (kind 'keep') or `with_columns(...)` (kind 'add').
function newColumnOps(method, args, kind) {
  const exprs = args.positional.flatMap((p) => {
    const t = p.trim();
    return t.startsWith('[') && matchBracket(t, 0) === t.length - 1
      ? splitTop(t.slice(1, -1), ',').filter((s) => s.trim())
      : [p];
  });
  const names = [...exprs.map(outputName), ...args.kwargs.keys()];
  const known = names.filter((n) => n !== null);
  if (!args.starred && known.length === names.length) return [{ kind, names }];
  const note = unknown(`\`${method}(…)\` ${kind === 'keep' ? 'selects' : 'adds'} columns whose names can't be determined`);
  return kind === 'add' && known.length ? [{ kind, names: known }, note] : [note];
}

// Column ops for `.method(args)` on the frame; null when the result isn't this
// frame's columns any more (groupby, pivot, ...).
function methodOps(method, args, flavor) {
  const { positional: pos, kwargs: kw } = args;
  switch (method) {
    case 'drop': {
      if (args.starred) return [unknown(`\`drop(*…)\` drops columns that can't be determined`)];
      if (kw.has('columns')) return [namesOp('drop', kw.get('columns'))];
      if (flavor === 'polars') return pos.map((p) => namesOp('drop', p));
      const labels = kw.get('labels') ?? pos[0];
      if (labels === undefined) return [];
      if (isColumnsAxis(kw.get('axis') ?? pos[1])) return [namesOp('drop', labels)];
      if (flavor === 'mixed' && !kw.has('axis') && !kw.has('index')) {
        return [unknown(`can't tell if \`drop(${short(labels)})\` drops rows (pandas) or columns (Polars)`)];
      }
      return [];
    }
    case 'rename': {
      let mapper = kw.get('columns');
      if (mapper === undefined) {
        const first = kw.get('mapper') ?? pos[0];
        if (first === undefined) return [];
        if (flavor === 'polars' || isColumnsAxis(kw.get('axis'))) mapper = first;
        else if (flavor === 'mixed' && !kw.has('axis')) {
          return [unknown(`can't tell if \`rename(${short(first)})\` renames rows (pandas) or columns (Polars)`)];
        } else return [];
      }
      const pairs = parseStringDict(mapper);
      return [pairs ? { kind: 'rename', pairs } : unknown(`renames columns with \`${short(mapper)}\``)];
    }
    case 'assign': {
      const ops = kw.size ? [{ kind: 'add', names: [...kw.keys()] }] : [];
      return args.starred ? [...ops, unknown('`assign(**…)` adds columns that can\'t be determined')] : ops;
    }
    case 'set_index': {
      const keys = kw.get('keys') ?? pos[0];
      return keys === undefined || kw.get('drop') === 'False' ? [] : [namesOp('drop', keys)];
    }
    case 'reset_index':
      return kw.get('drop') === 'True' ? [] : [unknown('`reset_index()` adds the index as column(s)')];
    case 'reindex': {
      const cols = kw.get('columns') ?? (isColumnsAxis(kw.get('axis')) ? pos[0] : undefined);
      return cols === undefined ? [] : [namesOp('keep', cols)];
    }
    case 'filter': {
      if (flavor === 'polars' || isRowsAxis(kw.get('axis'))) return [];
      const pattern = kw.get('like') ?? kw.get('regex');
      if (pattern !== undefined) return [unknown(`keeps only columns matching \`${short(pattern)}\``)];
      const items = kw.get('items') ?? pos[0];
      if (items === undefined) return [];
      const names = parseStringList(items);
      if (names) return [{ kind: 'keep', names }];
      return flavor === 'mixed' ? [] : [unknown(`keeps only columns in \`${short(items)}\``)];
    }
    case 'select':
      return newColumnOps(method, args, 'keep');
    case 'with_columns':
    case 'with_column':
      return newColumnOps(method, args, 'add');
    case 'with_row_index':
    case 'with_row_count':
      return [namesOp('add', kw.get('name') ?? pos[0] ?? (method === 'with_row_index' ? '"index"' : '"row_nr"'))];
    case 'merge':
    case 'join':
    case 'join_asof':
    case 'join_where':
    case 'hstack':
    case 'combine_first':
      return [unknown(`\`${method}(…)\` may add columns`)];
  }
  if (PRESERVE.has(method)) return [];
  if (RESHAPE.has(method)) return null;
  // `opaque`: not a known frame method, so the receiver may not be a frame at all.
  return [{ ...unknown(`\`${method}(…)\` may change the columns`), opaque: true }];
}

// Bracket bodies that probably hold column names rather than a row mask.
function looksLikeColumns(body) {
  const b = body.trim();
  return /^[fF][rR]?['"]/.test(b) || /^[\w.]*(?:col|field)\w*$/i.test(b) || b.startsWith('[');
}

// `frame[body]` inside an expression.
function indexOps(body) {
  const b = body.trim();
  if (parseString(b) !== null || /^[fF][rR]?['"]/.test(b)) return null; // a single column: a Series
  if (b.startsWith('[')) return [namesOp('keep', b)];
  return looksLikeColumns(b) ? [unknown(`selects columns from \`${short(b)}\``)] : []; // else a row filter
}

// `frame.loc[rows, cols]` / `frame.iloc[rows, cols]` inside an expression.
function locOps(attr, body) {
  const parts = splitTop(body, ',');
  if (parts.length < 2 || parts[1].trim() === ':') return [];
  const cols = parts[1].trim();
  if (attr === 'iloc') return [unknown('selects columns by position')];
  if (parseString(cols) !== null) return null;
  return [namesOp('keep', cols)];
}

// Ops for the trailers of `df.a(...).b(...)[...]`, or null if the result is reshaped.
function chainOps(trailers, flavor) {
  const ops = [];
  for (let k = 0; k < trailers.length; k++) {
    const t = trailers[k];
    const next = trailers[k + 1];
    let r;
    if (t.type === 'index') r = indexOps(t.body);
    else if (t.type === 'call') r = null;
    else if ((t.name === 'loc' || t.name === 'iloc') && next?.type === 'index') {
      r = locOps(t.name, next.body);
      k++;
    } else if (next?.type === 'call') {
      r = methodOps(t.name, parseArgs(next.body), flavor);
      k++;
    } else r = null; // `.T`, `.columns`, a column as an attribute...
    if (r === null) return null;
    ops.push(...r);
  }
  return ops;
}

// Ops for the value assigned in `name = value`.
function valueOps(value, name, flavor) {
  const chain = parseChain(value, name);
  if (!chain || chain.rest) return [RESET];
  return chainOps(chain.trailers, flavor) ?? [RESET];
}

const NOT_VARIABLES = new Set(['None', 'True', 'False', 'await', 'lambda', 'not', 'yield']);

// For `name = source[...].method(...)`, where `source` is another variable and the
// chain only makes column changes understood here: { source, ops }. Otherwise null.
function derivedFrom(text, name, flavor) {
  const parts = splitAssign(text);
  if (parts.length !== 2 || parts[0].trim() !== name) return null;
  const value = parts[1].trim();
  const source = value.replace(/^[(\s]+/, '').match(/^[A-Za-z_]\w*/)?.[0];
  if (!source || source === name || NOT_VARIABLES.has(source)) return null;
  const chain = parseChain(value, source);
  if (!chain || chain.rest) return null;
  const ops = chainOps(chain.trailers, flavor);
  return ops && !ops.some((op) => op.opaque) ? { source, ops } : null;
}

// `df["x"] = ...` and `df.loc[rows, "x"] = ...` style column assignment.
function assignedColumns(body) {
  const names = parseStringList(body);
  if (names) return [{ kind: 'add', names }];
  return looksLikeColumns(body) ? [unknown(`assigns columns from \`${short(body)}\``)] : [];
}

// Ops for assigning `value` to a target that isn't the bare name.
function targetOps(target, value, name) {
  const chain = parseChain(target, name);
  if (!chain || chain.rest) return [];
  const [a, b, extra] = chain.trailers;
  if (a?.type === 'index' && !b) return assignedColumns(a.body);
  if (a?.type === 'attr' && b?.type === 'index' && !extra && (a.name === 'loc' || a.name === 'at')) {
    const parts = splitTop(b.body, ',');
    return parts.length === 2 && parts[1].trim() !== ':' ? assignedColumns(parts[1]) : [];
  }
  if (a?.type === 'attr' && a.name === 'columns' && !b) {
    const names = parseStringList(value);
    return [names ? { kind: 'setColumns', names } : unknown(`columns replaced by \`${short(value)}\``)];
  }
  return [];
}

// In-place changes from calls anywhere in `text`: `df.pop("x")`, `df.insert(0, "x", v)`,
// `df.drop(columns=[...], inplace=True)`.
function mutationOps(text, name, flavor) {
  const ops = [];
  const masked = maskStrings(text);
  for (const m of masked.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close === -1) break;
    const args = parseArgs(text.slice(open + 1, close));
    const method = m[1];
    if (method === 'pop' || method === 'drop_in_place') {
      ops.push(namesOp('drop', args.positional[0] ?? args.kwargs.get('item') ?? args.kwargs.get('name')));
    } else if (method === 'insert' && flavor !== 'polars') {
      ops.push(namesOp('add', args.positional[1] ?? args.kwargs.get('column')));
    } else if (method === 'insert_column') {
      ops.push(unknown('`insert_column(…)` adds a column'));
    } else if (args.kwargs.get('inplace') === 'True') {
      ops.push(...(methodOps(method, args, flavor) ?? [unknown(`\`${method}(…, inplace=True)\` changes the columns`)]));
    }
  }
  return ops;
}

// True when the statement binds `name` to something new other than by `=`.
function binds(text, name) {
  const masked = maskStrings(text);
  if (new RegExp(`^(?:async\\s+)?(?:def|class)\\s+${name}\\b`).test(masked)) return true;
  if (new RegExp(`(?<![\\w.])${name}\\s*:=`).test(masked)) return true;
  const loop = masked.match(/^(?:async\s+)?for\s+(.+?)\s+in\b/);
  if (loop && targetNames(loop[1]).includes(name)) return true;
  if (/^(?:async\s+)?with\b/.test(masked) && new RegExp(`\\bas\\s+${name}\\b`).test(masked)) return true;
  const imp = masked.match(/^(?:from\s+\S+\s+)?import\s+(.+)$/);
  if (imp) {
    return imp[1].replace(/[()]/g, '').split(',').some((part) => {
      const [mod, alias] = part.trim().split(/\s+as\s+/);
      return (alias ?? mod.split('.')[0]).trim() === name;
    });
  }
  return false;
}

// Column ops one statement applies to `name` (empty when it doesn't touch it).
function analyzeStatement(text, name, flavor) {
  const del = text.match(/^del\s+([\s\S]*)$/);
  if (del) {
    const ops = [];
    for (const target of splitTop(del[1], ',')) {
      if (target.trim() === name) ops.push(RESET);
      const chain = parseChain(target, name);
      const [sub, extra] = chain?.trailers ?? [];
      if (sub?.type === 'index' && !extra && !chain.rest) ops.push(namesOp('drop', sub.body));
    }
    return ops;
  }
  if (binds(text, name)) return [RESET];

  const parts = splitAssign(text);
  if (parts.length > 1) {
    const value = parts[parts.length - 1];
    const ops = [];
    let rebinds = false;
    for (const part of parts.slice(0, -1)) {
      const [target, annotation] = splitTop(part, ':');
      const t = target.trim();
      const names = targetNames(t);
      if (t === name) {
        rebinds = true;
        ops.push(...(annotation !== undefined ? [RESET] : valueOps(value, name, flavor)));
      } else if (names.length > 1 && names.includes(name)) {
        rebinds = true;
        ops.push(RESET);
      } else {
        ops.push(...targetOps(t, value, name));
      }
    }
    return rebinds ? ops : [...ops, ...mutationOps(value, name, flavor)];
  }

  const annotated = splitTop(text, ':');
  if (annotated.length === 2 && annotated[0].trim() === name) return [RESET]; // `df: DataFrame[S]`
  return mutationOps(text, name, flavor);
}

// ---------------------------------------------------------------- tracing

// First `name` token in a statement's lines (skipping strings and comments),
// searching from `fromCol` on its first line.
function locate(lines, stmt, name, fromCol = 0) {
  const re = new RegExp(`(?<![\\w.])${name}\\b`, 'g');
  for (let n = stmt.start; n <= stmt.end; n++) {
    const code = maskStrings(lines[n]).replace(/#.*$/, '');
    re.lastIndex = n === stmt.start ? fromCol : 0;
    const m = re.exec(code);
    if (m) return { line: n, character: m.index };
  }
  return undefined;
}

// Whether the hovered token is the statement's assignment target (`df = ...`,
// `df["x"] = ...`, `del df["x"]`), in which case the hover shows the state after it.
function isTarget(stmt, name, line, character) {
  if (line !== stmt.start) return false;
  const offset = character - stmt.indent;
  if (!stmt.text.startsWith(name, offset) || /\w/.test(stmt.text[offset + name.length] ?? '')) return false;
  return offset === 0 || /^del\s/.test(stmt.text.slice(0, offset));
}

const MAX_FOLLOW = 5;

// Traces `name`, hovered at (line, character), back to the point where it got its
// current DataFrame (an assignment or a parameter) and lists the column changes
// since. Returns { origin: { line, character }, steps: [{ line, maybe, op }], fallback? },
// or null when there's no such point in the enclosing function (or module).
//
// When `name` was derived from another variable (`names = companies[["a", "b"]]`),
// that variable is traced too and the result starts at its origin. `fallback` then
// holds the next candidate, down to `name`'s own assignment, for when the deeper
// origin turns out not to have a schema.
function traceColumns(lines, name, line, character, flavor = 'pandas', depth = 0) {
  const stmts = splitStatements(lines);
  const h = stmts.findIndex((s) => s.start <= line && line <= s.end);
  if (h === -1 || SCOPE.test(stmts[h].text) || stmts[h].text.startsWith('@')) return null;

  const scope = ancestors(stmts, h).find((a) => SCOPE.test(stmts[a].text));
  const last = isTarget(stmts[h], name, line, character) ? h : h - 1;
  const events = [];
  for (let k = scope === undefined ? 0 : scope + 1; k <= last; k++) {
    const reach = reaches(stmts, k, h, scope);
    if (reach === 'never') continue;
    for (const op of analyzeStatement(stmts[k].text, name, flavor)) {
      events.push({ stmt: k, line: stmts[k].start, maybe: reach === 'maybe', op });
    }
  }

  const from = events.findLastIndex((e) => e.op.kind === 'reset' && !e.maybe);
  let origin;
  if (from !== -1) {
    origin = locate(lines, stmts[events[from].stmt], name);
  } else if (scope !== undefined && /^(?:async\s+)?def\b/.test(stmts[scope].text)) {
    const header = stmts[scope];
    origin = locate(lines, header, name, lines[header.start].indexOf('(') + 1);
  }
  if (!origin) return null;

  const steps = events.slice(from + 1).map(({ line: at, maybe, op }) => ({
    line: at,
    maybe,
    op: op.kind === 'reset' ? unknown(`\`${name}\` is reassigned`) : op,
  }));
  const own = { origin, steps };

  const assigned = from !== -1 && stmts[events[from].stmt];
  const derived = assigned && depth < MAX_FOLLOW && derivedFrom(assigned.text, name, flavor);
  const read = derived && locate(lines, assigned, derived.source);
  if (!read) return own;
  const later = [...derived.ops.map((op) => ({ line: assigned.start, maybe: false, op })), ...steps];
  // The source as read on the assignment line, in case its own trace finds nothing.
  const atRead = { origin: read, steps: later, fallback: own };
  const source = traceColumns(lines, derived.source, read.line, read.character, flavor, depth + 1);
  const extend = (t) => ({ origin: t.origin, steps: [...t.steps, ...later], fallback: t.fallback ? extend(t.fallback) : atRead });
  return source ? extend(source) : atRead;
}

// Applies traced steps to a schema's fields. Returns { columns, notes } where each
// column is { name, field?, added?, maybe?, dropped?, maybeDropped?, deselected?,
// renamedFrom?, renamedAt?, maybeRenamed? } (line numbers 1-based) and notes are
// { line, text, maybe } for changes that couldn't be worked out.
function applySteps(fields, steps) {
  const columns = fields.map((field) => ({ name: field.name, field }));
  const notes = [];
  const live = (name) => columns.find((c) => c.name === name && !c.dropped);

  for (const { line, maybe, op } of steps) {
    const at = line + 1;
    const drop = (c) => {
      if (!maybe) c.dropped = at;
      else c.maybeDropped ??= at;
    };
    const add = (name) => {
      const c = live(name);
      if (!c) columns.push({ name, added: at, maybe });
      else if (!maybe) {
        delete c.maybeDropped;
        if (c.added) c.maybe = false;
      }
    };
    const rename = (pairs) => {
      // Resolve every column first, so swaps like {a: b, b: a} work.
      for (const [c, to] of pairs.map(([from, to]) => [live(from), to]).filter(([c]) => c)) {
        if (maybe) {
          c.maybeRenamed = { to, at };
          continue;
        }
        c.renamedFrom ??= c.name;
        c.renamedAt = at;
        c.name = to;
        if (c.renamedFrom === to) {
          delete c.renamedFrom;
          delete c.renamedAt;
        }
      }
    };

    switch (op.kind) {
      case 'drop':
        for (const name of op.names) {
          const c = live(name);
          if (c) drop(c);
        }
        break;
      case 'add':
        op.names.forEach(add);
        break;
      case 'keep': {
        for (const c of columns) {
          if (op.names.includes(c.name)) continue;
          if (!c.dropped) drop(c);
          // Only the selected columns are worth showing after a definite selection.
          if (!maybe) c.deselected = true;
        }
        op.names.forEach(add);
        if (maybe) break;
        // The selection's order is the frame's new column order.
        const slots = columns.flatMap((c, i) => (c.dropped ? [] : [i]));
        const kept = slots.map((i) => columns[i]).sort((a, b) => op.names.indexOf(a.name) - op.names.indexOf(b.name));
        slots.forEach((i, k) => { columns[i] = kept[k]; });
        break;
      }
      case 'rename':
        rename(op.pairs);
        break;
      case 'setColumns': {
        const current = columns.filter((c) => !c.dropped);
        if (current.length === op.names.length) rename(current.map((c, i) => [c.name, op.names[i]]));
        else notes.push({ line: at, text: `columns replaced by ${op.names.length} new names`, maybe });
        break;
      }
      default:
        notes.push({ line: at, text: op.text, maybe });
    }
  }
  return { columns, notes };
}

// Renders traced columns as a ```diff block: `+` added, `-` dropped, `!` renamed or
// uncertain, with the line of each change as a comment. Columns left out by a
// selection (`df[["a", "b"]]`) aren't listed at all.
function formatTrace(traced) {
  const columns = traced.filter((c) => !c.deselected);
  if (!columns.length) return '  # (no columns)';
  const width = Math.max(...columns.map((c) => c.name.length));
  return columns
    .map((c) => {
      const comments = [];
      let mark = ' ';
      if (c.dropped) {
        mark = '-';
        comments.push(`dropped, line ${c.dropped}`);
      } else {
        if (c.field) comments.push(describeDefault(c.field.default));
        if (c.added) {
          mark = c.maybe ? '!' : '+';
          comments.push(`${c.maybe ? 'maybe added' : 'added'}, line ${c.added}`);
        }
        if (c.renamedFrom) {
          mark = '!';
          comments.push(`renamed from ${c.renamedFrom}, line ${c.renamedAt}`);
        }
        if (c.maybeRenamed) {
          mark = '!';
          comments.push(`maybe renamed to ${c.maybeRenamed.to}, line ${c.maybeRenamed.at}`);
        }
        if (c.maybeDropped) {
          mark = '!';
          comments.push(`maybe dropped, line ${c.maybeDropped}`);
        }
      }
      // Added columns have no known type, so there's nothing to align.
      const decl = c.field ? `${c.name.padEnd(width)}: ${c.field.annotation}` : c.name;
      const comment = comments.filter(Boolean).join('; ');
      return `${mark} ${decl}${comment ? `  # ${comment}` : ''}`;
    })
    .join('\n');
}

// 'polars', 'pandas' or 'mixed' (both imported), which decides what an ambiguous
// call like `df.drop("a")` (rows in pandas, columns in Polars) means.
function detectFlavor(source, hover = '') {
  if (/\bLazyFrame\b/.test(hover)) return 'polars';
  const polars = /^[ \t]*(?:import|from)[ \t]+(?:polars|pandera\.polars|pandera\.typing\.polars)\b/m.test(source);
  const pandas = /^[ \t]*(?:import|from)[ \t]+(?:pandas|geopandas|pandera\.pandas|pandera\.typing(?!\.polars)\b)/m.test(source);
  if (polars && pandas) return 'mixed';
  return polars ? 'polars' : 'pandas';
}

module.exports = {
  traceColumns,
  applySteps,
  formatTrace,
  detectFlavor,
  splitStatements,
  analyzeStatement,
};
