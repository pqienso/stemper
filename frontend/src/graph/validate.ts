import type { GraphSpec } from './types';
import { incomingRefs, validOutputPorts } from './types';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateGraph(graph: GraphSpec): ValidationResult {
  const errors: string[] = [];
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const refsByNode = new Map(graph.nodes.map((n) => [n.id, incomingRefs(n)]));

  const sources = graph.nodes.filter((n) => n.type === 'source');
  if (sources.length !== 1) {
    errors.push(`Graph must have exactly one Source node (got ${sources.length})`);
  }

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id: ${n.id}`);
    ids.add(n.id);
  }

  const outputs = graph.nodes.filter((n) => n.type === 'output');
  const labels = outputs.map((o: any) => o.label);
  if (new Set(labels).size !== labels.length) {
    errors.push('Output labels must be unique');
  }

  for (const n of graph.nodes) {
    for (const [refId, refPort] of refsByNode.get(n.id)!) {
      if (!refId) {
        errors.push(`Node "${n.id}" has an unconnected input`);
        continue;
      }
      const ref = nodeMap.get(refId);
      if (!ref) {
        errors.push(`Node "${n.id}" references unknown node "${refId}"`);
        continue;
      }
      const ports = validOutputPorts(ref);
      if (!ports.includes(refPort)) {
        errors.push(
          `Node "${n.id}" references invalid port "${refPort}" on "${refId}" (valid: ${ports.join(', ')})`,
        );
      }
    }

    if (n.type === 'mix' && n.inputs.length === 0) {
      errors.push(`Mix node "${n.id}" has no inputs`);
    }
    if (n.type === 'pitch_speed' && n.inputs.length === 0) {
      errors.push(`Pitch/Speed node "${n.id}" has no inputs`);
    }
  }

  // Kahn's algorithm for cycle detection.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of graph.nodes) dependents.set(n.id, []);
  for (const [id, refs] of refsByNode) {
    indegree.set(id, refs.length);
    for (const [src] of refs) dependents.get(src)?.push(id);
  }
  const queue: string[] = [];
  for (const [id, d] of indegree) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const dep of dependents.get(id) ?? []) {
      const d = indegree.get(dep)! - 1;
      indegree.set(dep, d);
      if (d === 0) queue.push(dep);
    }
  }
  if (visited !== graph.nodes.length) {
    errors.push('Graph has a cycle');
  }

  return { ok: errors.length === 0, errors };
}

// True if connecting `source -> target` would introduce a cycle — i.e. there
// is already a path from target back to source via existing edges.
export function wouldCreateCycle(
  edges: Array<{ source: string; target: string }>,
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return false;
}
