const test = require('node:test');
const assert = require('node:assert/strict');
const { toCsv, parseCsvToObjects } = require('../lib/csv');

test('toCsv neutralizes formula-injection characters (=, +, -, @) with a leading quote', () => {
  const rows = [
    { name: '=cmd|\'/c calc\'!A1' },
    { name: '+1+1' },
    { name: '-5' },
    { name: '@SUM(A1)' },
    { name: 'Normal Co' },
    { name: '-5 Corp' } // a legitimate name starting with a dash must still be prefixed —
    // this is the standard (OWASP) trade-off: every Excel/Sheets/LibreOffice
    // client would otherwise try to evaluate it as a formula on open.
  ];
  const csv = toCsv(rows, ['name']);
  const lines = csv.split('\r\n');
  assert.equal(lines[1], '\'=cmd|\'/c calc\'!A1');
  assert.equal(lines[2], '\'+1+1');
  assert.equal(lines[3], '\'-5');
  assert.equal(lines[4], '\'@SUM(A1)');
  assert.equal(lines[5], 'Normal Co');
  assert.equal(lines[6], '\'-5 Corp');
});

test('toCsv still quotes fields containing commas, quotes, or newlines', () => {
  const csv = toCsv([{ name: 'Acme, Inc.' }, { name: 'Say "hi"' }, { name: 'Line1\nLine2' }], ['name']);
  const lines = csv.split('\r\n');
  assert.equal(lines[1], '"Acme, Inc."');
  assert.equal(lines[2], '"Say ""hi"""');
  assert.equal(lines[3], '"Line1\nLine2"');
});

test('toCsv leaves ordinary values (including null/undefined) untouched', () => {
  const csv = toCsv([{ name: 'Acme Corp', notes: null }, { name: 'Other', notes: undefined }], ['name', 'notes']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'name,notes');
  assert.equal(lines[1], 'Acme Corp,');
  assert.equal(lines[2], 'Other,');
});

test('parseCsvToObjects round-trips a simple header+rows file', () => {
  const objs = parseCsvToObjects('name,domain\r\nAcme,acme.com\r\n"Say ""hi""",example.com\r\n');
  assert.deepEqual(objs, [
    { name: 'Acme', domain: 'acme.com' },
    { name: 'Say "hi"', domain: 'example.com' }
  ]);
});
