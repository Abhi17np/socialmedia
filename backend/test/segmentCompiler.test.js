const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTree, SegmentValidationError, nativeConditionToFragment, pgArrayLiteral, pgInList, isV2Filter
} = require('../lib/segmentCompiler');

test('isV2Filter() distinguishes the new tree shape from the legacy flat shape', () => {
  assert.equal(isV2Filter({ tags: ['vip'], hasPhone: true }), false);
  assert.equal(isV2Filter({}), false);
  assert.equal(isV2Filter(null), false);
  assert.equal(isV2Filter({ version: 2, root: { field: 'tags', operator: 'contains_any', value: ['vip'] } }), true);
});

test('validateTree() accepts a well-formed condition leaf', () => {
  assert.doesNotThrow(() => validateTree({ field: 'lead_score', operator: 'gte', value: 50 }));
});

test('validateTree() accepts a well-formed nested group', () => {
  assert.doesNotThrow(() => validateTree({
    logic: 'AND',
    children: [
      { field: 'tags', operator: 'contains_any', value: ['vip'] },
      { logic: 'OR', children: [{ field: 'lead_score', operator: 'gte', value: 50 }, { field: 'lifecycle_stage', operator: 'eq', value: 'customer' }] }
    ]
  }));
});

test('validateTree() rejects an unknown field', () => {
  assert.throws(() => validateTree({ field: 'favorite_color', operator: 'eq', value: 'blue' }), SegmentValidationError);
});

test('validateTree() rejects an operator not valid for the field', () => {
  assert.throws(() => validateTree({ field: 'tags', operator: 'gte', value: 5 }), SegmentValidationError);
});

test('validateTree() rejects a condition missing a value (except is_set/not_set)', () => {
  assert.throws(() => validateTree({ field: 'lead_score', operator: 'gte' }), SegmentValidationError);
  assert.doesNotThrow(() => validateTree({ field: 'email', operator: 'is_set' }));
});

test('validateTree() rejects an invalid group logic', () => {
  assert.throws(() => validateTree({ logic: 'XOR', children: [{ field: 'email', operator: 'is_set' }] }), SegmentValidationError);
});

test('validateTree() rejects an empty group', () => {
  assert.throws(() => validateTree({ logic: 'AND', children: [] }), SegmentValidationError);
});

test('validateTree() rejects a tree deeper than 8 levels', () => {
  let node = { field: 'email', operator: 'is_set' };
  for (let i = 0; i < 9; i++) node = { logic: 'AND', children: [node] };
  assert.throws(() => validateTree(node), SegmentValidationError);
});

test('validateTree() rejects more than MAX_TREE_NODES total nodes', () => {
  const children = [];
  for (let i = 0; i < 70; i++) children.push({ field: 'email', operator: 'is_set' });
  assert.throws(() => validateTree({ logic: 'OR', children }), SegmentValidationError);
});

test('pgArrayLiteral() produces a Postgres array literal and strips structural characters from values', () => {
  assert.equal(pgArrayLiteral(['vip', 'newsletter']), '{vip,newsletter}');
  assert.equal(pgArrayLiteral(['a,b', 'c{d}']), '{ab,cd}');
});

test('pgInList() produces a PostgREST in-list literal', () => {
  assert.equal(pgInList(['new', 'qualified']), '(new,qualified)');
});

test('nativeConditionToFragment() compiles every supported (field, operator) pair to the exact PostgREST syntax', () => {
  assert.equal(nativeConditionToFragment({ field: 'tags', operator: 'contains_any', value: ['vip'] }), 'tags.ov.{vip}');
  assert.equal(nativeConditionToFragment({ field: 'tags', operator: 'contains_all', value: ['vip', 'newsletter'] }), 'tags.cs.{vip,newsletter}');
  assert.equal(nativeConditionToFragment({ field: 'tags', operator: 'not_contains', value: ['spam'] }), 'tags.not.ov.{spam}');
  assert.equal(nativeConditionToFragment({ field: 'lead_status', operator: 'eq', value: 'qualified' }), 'lead_status.eq.qualified');
  assert.equal(nativeConditionToFragment({ field: 'lead_status', operator: 'in', value: ['new', 'qualified'] }), 'lead_status.in.(new,qualified)');
  assert.equal(nativeConditionToFragment({ field: 'lifecycle_stage', operator: 'neq', value: 'customer' }), 'lifecycle_stage.neq.customer');
  assert.equal(nativeConditionToFragment({ field: 'lead_score', operator: 'gte', value: 50 }), 'lead_score.gte.50');
  assert.equal(nativeConditionToFragment({ field: 'email', operator: 'is_set' }), 'email.not.is.null');
  assert.equal(nativeConditionToFragment({ field: 'email', operator: 'not_set' }), 'email.is.null');
  assert.equal(nativeConditionToFragment({ field: 'phone', operator: 'is_set' }), 'phone.not.is.null');
  assert.equal(nativeConditionToFragment({ field: 'owner_id', operator: 'eq', value: 'u1' }), 'owner_id.eq.u1');
  assert.equal(nativeConditionToFragment({ field: 'owner_id', operator: 'not_set' }), 'owner_id.is.null');
  assert.equal(nativeConditionToFragment({ field: 'created_at', operator: 'after', value: '2026-01-01' }), 'created_at.gte.2026-01-01');
  assert.equal(nativeConditionToFragment({ field: 'created_at', operator: 'before', value: '2026-06-01' }), 'created_at.lt.2026-06-01');
  assert.equal(nativeConditionToFragment({ field: 'display_name', operator: 'contains', value: 'Jane' }), 'display_name.ilike.*Jane*');
  assert.equal(nativeConditionToFragment({ field: 'global_opt_out', operator: 'eq', value: true }), 'global_opt_out_at.not.is.null');
  assert.equal(nativeConditionToFragment({ field: 'global_opt_out', operator: 'eq', value: false }), 'global_opt_out_at.is.null');
});

test('nativeConditionToFragment() double-quotes a value containing PostgREST-structural characters instead of emitting them unescaped', () => {
  const frag = nativeConditionToFragment({ field: 'owner_id', operator: 'eq', value: 'a,b(c)' });
  assert.equal(frag, 'owner_id.eq."a,b(c)"');
});
