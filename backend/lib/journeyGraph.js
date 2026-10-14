/**
 * Pure graph helpers for the journey engine (lib/journeyEngine.js) — node/
 * edge lookups, condition evaluation against an in-memory contact, and
 * deterministic branch selection. No DB, no network: fully unit-testable
 * (test/journeyGraph.test.js), which matters because this is where a
 * subtle bug (picking the wrong branch, an off-by-one in edge traversal)
 * would silently misroute every contact in a live journey.
 *
 * Graph shape (workflow_definitions.graph_json):
 *   { nodes: [{ id, type: 'trigger'|'delay'|'condition'|'action'|'split', ... }],
 *     edges: [{ id, source, target, branch? }] }
 * A condition node's two outgoing edges are distinguished by
 * `branch: 'yes'|'no'`; a split node's N outgoing edges each carry a
 * `weight` (summing to 100 is expected but not required — see
 * pickSplitEdge()'s normalization).
 */

class JourneyGraphError extends Error {}

function findNode(graph, nodeId) {
  return (graph.nodes || []).find((n) => n.id === nodeId) || null;
}

function outgoingEdges(graph, nodeId) {
  return (graph.edges || []).filter((e) => e.source === nodeId);
}

function nextNodeId(graph, nodeId) {
  const edges = outgoingEdges(graph, nodeId);
  return edges.length > 0 ? edges[0].target : null;
}

/** Validates the graph has exactly one trigger node, every edge references real nodes, and every condition/split node's branches are well-formed. Throws JourneyGraphError with a user-safe message. */
function validateGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new JourneyGraphError('A journey needs nodes and edges arrays.');
  if (graph.nodes.length === 0) throw new JourneyGraphError('A journey needs at least one node.');

  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node.id || typeof node.id !== 'string') throw new JourneyGraphError('Every node needs a string id.');
    if (ids.has(node.id)) throw new JourneyGraphError(`Duplicate node id "${node.id}".`);
    ids.add(node.id);
    if (!['trigger', 'delay', 'condition', 'action', 'split'].includes(node.type)) throw new JourneyGraphError(`Unknown node type "${node.type}".`);
  }

  const triggerNodes = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggerNodes.length !== 1) throw new JourneyGraphError('A journey needs exactly one trigger node.');

  for (const edge of graph.edges) {
    if (!ids.has(edge.source)) throw new JourneyGraphError(`Edge references unknown source node "${edge.source}".`);
    if (!ids.has(edge.target)) throw new JourneyGraphError(`Edge references unknown target node "${edge.target}".`);
  }

  for (const node of graph.nodes) {
    const edges = outgoingEdges(graph, node.id);
    if (node.type === 'condition') {
      const branches = edges.map((e) => e.branch).sort();
      if (JSON.stringify(branches) !== JSON.stringify(['no', 'yes'])) throw new JourneyGraphError(`Condition node "${node.id}" needs exactly one "yes" and one "no" outgoing edge.`);
    }
    if (node.type === 'split') {
      if (edges.length < 2) throw new JourneyGraphError(`Split node "${node.id}" needs at least 2 outgoing edges.`);
      if (edges.some((e) => typeof e.weight !== 'number' || e.weight <= 0)) throw new JourneyGraphError(`Every outgoing edge of split node "${node.id}" needs a positive weight.`);
    }
    if (['action', 'delay'].includes(node.type) && edges.length > 1) throw new JourneyGraphError(`Node "${node.id}" (${node.type}) can have at most one outgoing edge.`);
  }
}

const CONDITION_OPERATORS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => Array.isArray(a) && a.includes(b),
  not_contains: (a, b) => !(Array.isArray(a) && a.includes(b))
};

const CONDITION_FIELD_ACCESSORS = {
  lead_score: (c) => c.lead_score,
  lead_status: (c) => c.lead_status,
  lifecycle_stage: (c) => c.lifecycle_stage,
  tags: (c) => c.tags || [],
  has_email: (c) => !!c.email,
  has_phone: (c) => !!c.phone
};

/** Evaluates a single { field, operator, value } condition against an already-loaded contact row — no DB query, unlike lib/segmentCompiler.js which builds one. Unknown field/operator fails safe (false), never throws mid-journey. */
function evaluateCondition(condition, contact) {
  const accessor = CONDITION_FIELD_ACCESSORS[condition?.field];
  const operator = CONDITION_OPERATORS[condition?.operator];
  if (!accessor || !operator) return false;
  return operator(accessor(contact), condition.value);
}

function conditionEdge(graph, nodeId, result) {
  const edges = outgoingEdges(graph, nodeId);
  return edges.find((e) => e.branch === (result ? 'yes' : 'no')) || null;
}

/** Deterministic split: the same contact always lands in the same branch if a tick is ever re-run (hash of contactId), same reasoning as lib/email/campaignSender.js's A/B variant picker — never Math.random() for something that must be stable/idempotent. */
function pickSplitEdge(graph, nodeId, contactId) {
  const edges = outgoingEdges(graph, nodeId);
  const total = edges.reduce((sum, e) => sum + e.weight, 0);
  let hash = 0;
  for (let i = 0; i < contactId.length; i++) hash = (hash * 31 + contactId.charCodeAt(i)) >>> 0;
  const point = (hash % 1000) / 1000 * total;
  let cumulative = 0;
  for (const edge of edges) {
    cumulative += edge.weight;
    if (point < cumulative) return edge;
  }
  return edges[edges.length - 1];
}

module.exports = {
  JourneyGraphError, findNode, outgoingEdges, nextNodeId, validateGraph,
  evaluateCondition, conditionEdge, pickSplitEdge, CONDITION_FIELD_ACCESSORS, CONDITION_OPERATORS
};
