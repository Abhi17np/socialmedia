const test = require('node:test');
const assert = require('node:assert/strict');
const {
  JourneyGraphError, findNode, outgoingEdges, nextNodeId, validateGraph,
  evaluateCondition, conditionEdge, pickSplitEdge
} = require('../lib/journeyGraph');

function linearGraph() {
  return {
    nodes: [{ id: 't', type: 'trigger' }, { id: 'a', type: 'action' }, { id: 'd', type: 'delay' }],
    edges: [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 'a', target: 'd' }]
  };
}

test('findNode() finds a node by id, returns null for unknown', () => {
  const g = linearGraph();
  assert.equal(findNode(g, 'a').type, 'action');
  assert.equal(findNode(g, 'nope'), null);
});

test('outgoingEdges() / nextNodeId() follow a linear chain', () => {
  const g = linearGraph();
  assert.equal(outgoingEdges(g, 't').length, 1);
  assert.equal(nextNodeId(g, 't'), 'a');
  assert.equal(nextNodeId(g, 'd'), null, 'a terminal node has no outgoing edge');
});

test('validateGraph() accepts a well-formed linear graph', () => {
  assert.doesNotThrow(() => validateGraph(linearGraph()));
});

test('validateGraph() requires exactly one trigger node', () => {
  assert.throws(() => validateGraph({ nodes: [{ id: 'a', type: 'action' }], edges: [] }), JourneyGraphError);
  assert.throws(() => validateGraph({ nodes: [{ id: 't1', type: 'trigger' }, { id: 't2', type: 'trigger' }], edges: [] }), JourneyGraphError);
});

test('validateGraph() rejects a duplicate node id', () => {
  assert.throws(() => validateGraph({ nodes: [{ id: 't', type: 'trigger' }, { id: 't', type: 'action' }], edges: [] }), JourneyGraphError);
});

test('validateGraph() rejects an edge referencing an unknown node', () => {
  assert.throws(() => validateGraph({ nodes: [{ id: 't', type: 'trigger' }], edges: [{ id: 'e1', source: 't', target: 'ghost' }] }), JourneyGraphError);
});

test('validateGraph() requires a condition node to have exactly one yes and one no edge', () => {
  const bad = { nodes: [{ id: 't', type: 'trigger' }, { id: 'c', type: 'condition' }], edges: [{ id: 'e1', source: 't', target: 'c' }, { id: 'e2', source: 'c', target: 't', branch: 'yes' }] };
  assert.throws(() => validateGraph(bad), JourneyGraphError);
});

test('validateGraph() accepts a well-formed condition node', () => {
  const g = {
    nodes: [{ id: 't', type: 'trigger' }, { id: 'c', type: 'condition' }, { id: 'a1', type: 'action' }, { id: 'a2', type: 'action' }],
    edges: [{ id: 'e1', source: 't', target: 'c' }, { id: 'e2', source: 'c', target: 'a1', branch: 'yes' }, { id: 'e3', source: 'c', target: 'a2', branch: 'no' }]
  };
  assert.doesNotThrow(() => validateGraph(g));
});

test('validateGraph() requires a split node to have at least 2 positively-weighted edges', () => {
  const noWeight = { nodes: [{ id: 't', type: 'trigger' }, { id: 's', type: 'split' }, { id: 'a', type: 'action' }], edges: [{ id: 'e1', source: 't', target: 's' }, { id: 'e2', source: 's', target: 'a' }] };
  assert.throws(() => validateGraph(noWeight), JourneyGraphError);
});

test('validateGraph() rejects an action node with more than one outgoing edge', () => {
  const g = { nodes: [{ id: 't', type: 'trigger' }, { id: 'a', type: 'action' }, { id: 'x', type: 'action' }, { id: 'y', type: 'action' }], edges: [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 'a', target: 'x' }, { id: 'e3', source: 'a', target: 'y' }] };
  assert.throws(() => validateGraph(g), JourneyGraphError);
});

test('evaluateCondition() evaluates every supported operator correctly', () => {
  const contact = { lead_score: 60, lead_status: 'qualified', tags: ['vip'], email: 'a@b.com', phone: null };
  assert.equal(evaluateCondition({ field: 'lead_score', operator: 'gte', value: 50 }, contact), true);
  assert.equal(evaluateCondition({ field: 'lead_score', operator: 'lt', value: 50 }, contact), false);
  assert.equal(evaluateCondition({ field: 'lead_status', operator: 'eq', value: 'qualified' }, contact), true);
  assert.equal(evaluateCondition({ field: 'tags', operator: 'contains', value: 'vip' }, contact), true);
  assert.equal(evaluateCondition({ field: 'tags', operator: 'not_contains', value: 'vip' }, contact), false);
  assert.equal(evaluateCondition({ field: 'has_email', operator: 'eq', value: true }, contact), true);
  assert.equal(evaluateCondition({ field: 'has_phone', operator: 'eq', value: true }, contact), false);
});

test('evaluateCondition() fails safe (false) for an unknown field or operator, never throws', () => {
  assert.equal(evaluateCondition({ field: 'nonsense', operator: 'eq', value: 1 }, {}), false);
  assert.equal(evaluateCondition({ field: 'lead_score', operator: 'nonsense', value: 1 }, { lead_score: 5 }), false);
  assert.doesNotThrow(() => evaluateCondition(null, {}));
});

test('evaluateCondition() reads last_message_status from the value lib/journeyEngine.js injects, never from the real contact row', () => {
  assert.equal(evaluateCondition({ field: 'last_message_status', operator: 'eq', value: 'delivered' }, { _lastMessageStatus: 'delivered' }), true);
  assert.equal(evaluateCondition({ field: 'last_message_status', operator: 'neq', value: 'delivered' }, { _lastMessageStatus: 'failed' }), true);
  assert.equal(evaluateCondition({ field: 'last_message_status', operator: 'eq', value: 'delivered' }, {}), false, 'no send has happened yet in this journey — null never matches a real status');
});

test('conditionEdge() picks the yes/no edge based on the evaluated result', () => {
  const g = {
    nodes: [{ id: 'c', type: 'condition' }], edges: [{ id: 'e1', source: 'c', target: 'yesTarget', branch: 'yes' }, { id: 'e2', source: 'c', target: 'noTarget', branch: 'no' }]
  };
  assert.equal(conditionEdge(g, 'c', true).target, 'yesTarget');
  assert.equal(conditionEdge(g, 'c', false).target, 'noTarget');
});

test('pickSplitEdge() is deterministic for the same contact id', () => {
  const g = { nodes: [], edges: [{ id: 'e1', source: 's', target: 'a', weight: 50 }, { id: 'e2', source: 's', target: 'b', weight: 50 }] };
  const first = pickSplitEdge(g, 's', 'contact-123');
  const second = pickSplitEdge(g, 's', 'contact-123');
  assert.equal(first.target, second.target);
});

test('pickSplitEdge() distributes across multiple distinct contact ids (not always the same branch)', () => {
  const g = { nodes: [], edges: [{ id: 'e1', source: 's', target: 'a', weight: 50 }, { id: 'e2', source: 's', target: 'b', weight: 50 }] };
  const targets = new Set();
  for (let i = 0; i < 50; i++) targets.add(pickSplitEdge(g, 's', `contact-${i}-${Math.random()}`).target);
  assert.ok(targets.size > 1, 'expected both branches to be reachable across many different contact ids');
});

test('pickSplitEdge() respects unequal weights heavily favoring one branch', () => {
  const g = { nodes: [], edges: [{ id: 'e1', source: 's', target: 'rare', weight: 1 }, { id: 'e2', source: 's', target: 'common', weight: 99 }] };
  let commonCount = 0;
  for (let i = 0; i < 200; i++) {
    if (pickSplitEdge(g, 's', `id-${i}-${Math.random()}`).target === 'common') commonCount += 1;
  }
  assert.ok(commonCount > 150, `expected the heavily-weighted branch to dominate, got ${commonCount}/200`);
});
