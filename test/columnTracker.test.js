'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  traceColumns, applySteps, formatTrace, detectFlavor, splitStatements,
} = require('../columnTracker');

const SCHEMA = ['id', 'customerId', 'status', 'total'].map((name) => ({
  name, annotation: 'Series[int]', default: undefined,
}));

// Hovers the `nth` occurrence of `name` on the line marked with `# <-`.
function hover(source, { name = 'df', nth = 0, flavor = 'pandas' } = {}) {
  const lines = source.split('\n');
  const line = lines.findIndex((l) => l.includes('# <-'));
  const re = new RegExp(`(?<![\\w.])${name}\\b`, 'g');
  const character = [...lines[line].matchAll(re)][nth].index;
  return traceColumns(lines, name, line, character, flavor);
}

// Live column names (dropped ones left out) and note texts after the trace.
function result(source, options) {
  const trace = hover(source, options);
  if (!trace) return null;
  const { columns, notes } = applySteps(SCHEMA, trace.steps);
  return {
    origin: trace.origin.line,
    live: columns.filter((c) => !c.dropped).map((c) => c.name + (c.maybe || c.maybeDropped ? '?' : '')),
    notes: notes.map((n) => n.text + (n.maybe ? '?' : '')),
  };
}

const lines = (...l) => l.join('\n');

test('drop reassigned to the same variable: changed on the target, not before', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'df = df.drop(columns=["status", "total"])  # <-',
  );
  assert.deepEqual(result(src), { origin: 0, live: ['id', 'customerId'], notes: [] });
  // The `df` read on the right-hand side is still the original frame.
  assert.deepEqual(hover(src, { nth: 1 }).steps, []);
});

test('hovering the declaration itself has nothing to trace', () => {
  const src = lines('df: DataFrame[OrderSchema] = load()  # <-', 'df = df.drop(columns="id")');
  assert.deepEqual(hover(src).steps, []);
});

test('parameter origin and the common pandas operations', () => {
  const src = lines(
    'def clean(df: DataFrame[OrderSchema], other) -> None:',
    '    df["discount"] = 0',
    '    del df["customerId"]',
    '    df = df.rename(columns={"total": "amount"})',
    '    df.drop("status", axis=1, inplace=True)',
    '    df = df.assign(tax=1, net=lambda d: d.amount)',
    '    df.loc[:, "flag"] = True',
    '    removed = df.pop("tax")',
    '    df.insert(0, "first", 1)',
    '    print(df)  # <-',
  );
  assert.deepEqual(result(src), {
    origin: 0,
    live: ['id', 'amount', 'discount', 'net', 'flag', 'first'],
    notes: [],
  });
});

test('selection, row filters and preserving methods', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'df = df[df["total"] > 0].copy()',
    'df = df.sort_values("id").dropna()[["id", "total"]]',
    'df = df.loc[df.id > 3, ["id"]]',
    'df  # <-',
  );
  assert.deepEqual(result(src).live, ['id']);
});

test('multi-line chains with comments', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'df = (',
    '    df.drop(columns=["status"])  # not needed',
    '    .rename(',
    '        columns={"total": "amount"},',
    '    )',
    ')',
    'df  # <-',
  );
  assert.deepEqual(result(src).live, ['id', 'customerId', 'amount']);
});

test('reshaping or rebinding starts over from that line', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'df = df.drop(columns=["status"])',
    'df = df.groupby("customerId").agg(total=("total", "sum"))',
    'df["x"] = 1',
    'df  # <-',
  );
  const trace = hover(src);
  assert.equal(trace.origin.line, 2);
  assert.equal(trace.steps.length, 1);

  const annotated = lines(
    'df: DataFrame[OrderSchema] = load()',
    'df = df.drop(columns=["status"])',
    'df: DataFrame[Other] = df.drop(columns=["total"])',
    'df  # <-',
  );
  assert.deepEqual(hover(annotated), { origin: { line: 2, character: 0 }, steps: [] });
});

test('branches are "maybe", exclusive arms are skipped, with-blocks always run', () => {
  const src = lines(
    'def f(df: DataFrame[OrderSchema], flag):',
    '    if flag:',
    '        df = df.drop(columns=["status"])',
    '    elif other:',
    '        df["a"] = 1',
    '    else:',
    '        df["b"] = 1',
    '        print(df)  # <-',
    '    with ctx():',
    '        df["c"] = 1',
  );
  assert.deepEqual(result(src).live, ['id', 'customerId', 'status', 'total', 'b']);

  const after = lines(
    'def f(df: DataFrame[OrderSchema], flag):',
    '    if flag:',
    '        df = df.drop(columns=["status"])',
    '    for x in range(3):',
    '        df[f"col_{x}"] = x',
    '    with ctx():',
    '        df["c"] = 1',
    '    return df  # <-',
  );
  assert.deepEqual(result(after), {
    origin: 0,
    live: ['id', 'customerId', 'status?', 'total', 'c'],
    notes: ['assigns columns from `f"col_{x}"`?'],
  });
});

test('nested functions are ignored; module scope works too', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'def helper(df):',
    '    df["inner"] = 1',
    'df["outer"] = 1',
    'df  # <-',
  );
  assert.deepEqual(result(src).live, ['id', 'customerId', 'status', 'total', 'outer']);
});

test('non-literal column names become notes instead of guesses', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'df = df.drop(columns=to_drop)',
    'df = df.merge(customers, on="customerId")',
    'df = df.reset_index()',
    'df[cols] = 0',
    'df[mask] = 0',
    'df  # <-',
  );
  assert.deepEqual(result(src).notes, [
    'drops columns from `to_drop`',
    '`merge(…)` may add columns',
    '`reset_index()` adds the index as column(s)',
    'assigns columns from `cols`',
  ]);
});

test('positional drop/rename means rows in pandas, columns in Polars', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'df = df.drop(["status"]).rename({"total": "amount"})',
    'df  # <-',
  );
  assert.deepEqual(result(src).live, ['id', 'customerId', 'status', 'total']);
  assert.deepEqual(result(src, { flavor: 'polars' }).live, ['id', 'customerId', 'amount']);
  assert.equal(result(src, { flavor: 'mixed' }).notes.length, 2);
});

test('polars select and with_columns', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'df = df.with_columns(',
    '    (pl.col("total") * 1.17).alias("gross"),',
    '    pl.col("status").str.to_lowercase(),',
    '    flag=pl.lit(True),',
    ')',
    'df = df.select("id", pl.col("gross"), pl.col("status").alias("state"), "flag")',
    'df = df.drop("flag").filter(pl.col("id") > 0).collect()',
    'df  # <-',
  );
  assert.deepEqual(result(src, { flavor: 'polars' }).live, ['id', 'gross', 'state']);

  const wildcard = lines('df: DataFrame[OrderSchema] = load()', 'df = df.select(pl.all())', 'df  # <-');
  assert.deepEqual(result(wildcard, { flavor: 'polars' }).notes, ['`select(…)` selects columns whose names can\'t be determined']);
});

test('a variable selected from another one shows only the selected columns', () => {
  const src = lines(
    'class Importer:',
    '    async def _add_companies(self, companies_with_equity_df: DataFrame[OrderSchema]):',
    '',
    '        companies_names = companies_with_equity_df[["total", "id"]]  # <-',
    '        pass',
  );
  const trace = hover(src, { name: 'companies_names' });
  // Starts at the parameter, with the source's own assignment and read as fallbacks.
  assert.deepEqual(trace.origin, { line: 1, character: 35 });
  assert.equal(trace.fallback.origin.line, 3);
  assert.equal(trace.fallback.fallback.origin.character, 8);
  assert.equal(trace.fallback.fallback.fallback, undefined);

  const { columns } = applySteps(SCHEMA, trace.steps);
  assert.equal(formatTrace(columns), [
    '  total: Series[int]',
    '  id   : Series[int]',
  ].join('\n'));
});

test('derived variables carry the source\'s earlier changes and their own later ones', () => {
  const src = lines(
    'def f(orders: DataFrame[OrderSchema]):',
    '    orders = orders.drop(columns=["status"])',
    '    slim = orders.rename(columns={"total": "amount"})',
    '    slim["tax"] = 1',
    '    return slim  # <-',
  );
  assert.deepEqual(result(src, { name: 'slim' }), {
    origin: 0,
    live: ['id', 'customerId', 'amount', 'tax'],
    notes: [],
  });
});

test('values that aren\'t a frame method chain on another variable aren\'t followed', () => {
  for (const value of ['OrderSchema.validate(raw)', 'pd.read_csv(path)', 'raw.groupby("id").sum()', 'self.df[["id"]]']) {
    const src = lines('def f(raw: DataFrame[OrderSchema]):', `    df = ${value}`, '    df["x"] = 1', '    df  # <-');
    const trace = hover(src);
    assert.equal(trace.origin.line, 1, value);
    assert.equal(trace.fallback, undefined, value);
  }
});

test('no origin in scope means no trace', () => {
  assert.equal(hover(lines('def f():', '    df["x"] = 1', '    df  # <-')), null);
  assert.equal(hover(lines('def f(df: DataFrame[S]):  # <-', '    pass')), null);
});

test('formats the changes as a diff', () => {
  const src = lines(
    'df: DataFrame[OrderSchema] = load()',
    'if x:',
    '    df = df.drop(columns=["customerId"])',
    'df = df.drop(columns=["status"]).rename(columns={"total": "amount"})',
    'df["discount"] = 0',
    'df  # <-',
  );
  const fields = SCHEMA.map((f) => (f.name === 'total' ? { ...f, default: 'pa.Field(ge=0)' } : f));
  const { columns } = applySteps(fields, hover(src).steps);
  assert.equal(formatTrace(columns), [
    '  id        : Series[int]',
    '! customerId: Series[int]  # maybe dropped, line 3',
    '- status    : Series[int]  # dropped, line 4',
    '! amount    : Series[int]  # ge=0; renamed from total, line 4',
    '+ discount  # added, line 5',
  ].join('\n'));
});

test('splits statements across brackets, strings and backslashes', () => {
  const stmts = splitStatements([
    'x = """doc',
    'df = 1',
    '"""',
    'y = 1 + \\',
    '    2',
    'z = f(  # comment (',
    '',
    'w = 3',
  ]);
  assert.deepEqual(stmts.map((s) => [s.start, s.end, s.text.replace(/\s+/g, ' ')]), [
    [0, 2, 'x = """doc df = 1 """'],
    [3, 4, 'y = 1 + 2'],
    [5, 5, 'z = f('], // unclosed bracket stops at the next statement
    [7, 7, 'w = 3'],
  ]);
});

test('detects the frame library from imports', () => {
  assert.equal(detectFlavor('import pandas as pd\nfrom pandera.typing import DataFrame'), 'pandas');
  assert.equal(detectFlavor('import polars as pl\nfrom pandera.typing.polars import DataFrame'), 'polars');
  assert.equal(detectFlavor('import pandas as pd\nimport polars as pl'), 'mixed');
  assert.equal(detectFlavor('import pandas', 'x: LazyFrame[S]'), 'polars');
});
