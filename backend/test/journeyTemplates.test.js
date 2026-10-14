const test = require('node:test');
const assert = require('node:assert/strict');
const { JOURNEY_TEMPLATES } = require('../lib/journeyTemplates');
const { validateGraph } = require('../lib/journeyGraph');

test('every prebuilt journey template is a real, valid graph', () => {
  const keys = Object.keys(JOURNEY_TEMPLATES);
  assert.ok(keys.length >= 7, 'the task brief names 7 template journeys');
  for (const key of keys) {
    const t = JOURNEY_TEMPLATES[key];
    assert.ok(t.name && t.description && t.triggerType && t.graph, `template "${key}" is missing a required field`);
    assert.doesNotThrow(() => validateGraph(t.graph), `template "${key}"'s graph should validate`);
  }
});

test('every prebuilt template graph is a simple line (no branching) exactly as documented', () => {
  for (const [key, t] of Object.entries(JOURNEY_TEMPLATES)) {
    for (const node of t.graph.nodes) {
      const outgoing = t.graph.edges.filter((e) => e.source === node.id);
      assert.ok(outgoing.length <= 1, `template "${key}" node "${node.id}" should have at most one outgoing edge (templates are meant to be linear)`);
    }
  }
});
