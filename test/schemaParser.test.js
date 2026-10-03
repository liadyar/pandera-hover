'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseClass, findClassLine, formatFields } = require('../schemaParser');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/schemas.py'), 'utf8');

function classOf(source, name) {
  const lines = source.split(/\r?\n/);
  return parseClass(lines, findClassLine(lines, name));
}

test('reads a pandera schema, skipping comments, docstring and Config', () => {
  const cls = classOf(FIXTURE, 'OrderSchema');
  assert.deepEqual(cls.bases, ['pa.DataFrameModel']);
  assert.deepEqual(cls.fields, [
    { name: 'id', annotation: 'Series[int]', default: undefined },
    { name: 'customerId', annotation: 'Series[int]', default: undefined },
    { name: 'couponId', annotation: 'Optional[Series[pd.Int64Dtype]]', default: 'pa.Field(nullable=True)' },
    { name: 'status', annotation: 'Series[str]', default: 'pa.Field(isin=["OPEN", "SHIPPED", "CANCELLED"])' },
    { name: 'total', annotation: 'Series[float]', default: 'pa.Field(ge=0)' },
  ]);
});

test('reports a subclass schema with its base', () => {
  const cls = classOf(FIXTURE, 'ShippedOrderSchema');
  assert.deepEqual(cls.bases, ['OrderSchema']);
  assert.deepEqual(cls.fields.map((f) => f.name), ['shippedAt']);
});

test('handles docstrings, multi-line defaults, nested blocks and tricky strings', () => {
  const source = [
    'class Child(Parent):',
    '    """Multi-line',
    '    a: Series[int]  <- inside docstring, not a field',
    '    """',
    '',
    '    a: Series[int]  # trailing comment',
    '    b: Series[str] = pa.Field(',
    '        isin=["x=y", "#notcomment"],',
    '        nullable=True,',
    '    )',
    '    c: Optional[Series[float]]',
    '',
    '    class Config:',
    '        coerce: bool = True',
    '',
    '    def method(self):',
    '        local: int = 1',
    '',
    'not_in_class: int = 2',
  ].join('\n');
  const cls = classOf(source, 'Child');
  assert.deepEqual(cls.bases, ['Parent']);
  assert.deepEqual(cls.fields, [
    { name: 'a', annotation: 'Series[int]', default: undefined },
    { name: 'b', annotation: 'Series[str]', default: 'pa.Field( isin=["x=y", "#notcomment"], nullable=True, )' },
    { name: 'c', annotation: 'Optional[Series[float]]', default: undefined },
  ]);
});

test('reads CRLF sources', () => {
  const cls = classOf(FIXTURE.replace(/\r?\n/g, '\r\n'), 'OrderSchema');
  assert.equal(cls.fields.length, 5);
});

test('returns -1 / null for a missing class', () => {
  const lines = FIXTURE.split('\n');
  assert.equal(findClassLine(lines, 'Nope'), -1);
  assert.equal(findClassLine(lines, 'OrderSchem'), -1);
  assert.equal(parseClass(lines, 0), null);
});

test('formats aligned fields with Field args as comments', () => {
  const text = formatFields([
    { name: 'id', annotation: 'Series[int]', default: undefined },
    { name: 'couponId', annotation: 'Series[str]', default: 'pa.Field(nullable=True)' },
    { name: 'x', annotation: 'int', default: '3' },
  ]);
  assert.equal(text, [
    'id      : Series[int]',
    'couponId: Series[str]  # nullable=True',
    'x       : int  # = 3',
  ].join('\n'));
});
