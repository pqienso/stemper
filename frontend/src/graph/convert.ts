import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { GraphSpec, NodeSpec } from './types';
import { parseSlotHandle } from './types';

export function specToFlow(graph: GraphSpec): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    data: { ...n },  // stash the full spec
    deletable: n.type !== 'source' && n.type !== 'pitch_speed' && n.type !== 'output',
  }));

  const edges: FlowEdge[] = [];

  const targetById = new Map(graph.nodes.map((n) => [n.id, n.type]));

  const addEdge = (
    sourceId: string,
    sourcePort: string,
    targetId: string,
    targetPort: string,
    gain?: number,
  ) => {
    const color = gain !== undefined && gain < 0 ? '#fb4934' : '#a89984';
    edges.push({
      id: `${sourceId}:${sourcePort}->${targetId}:${targetPort}`,
      source: sourceId,
      sourceHandle: sourcePort,
      target: targetId,
      targetHandle: targetPort,
      animated: false,
      style: { stroke: color, strokeWidth: 4 },
      interactionWidth: 30,
      // pitch_speed → Output edges are managed by the derivation effect.
      // Mark them non-deletable so the user can't break the invariant from
      // the canvas.
      deletable: targetById.get(targetId) !== 'output',
      data: { gain },
    });
  };

  for (const n of graph.nodes) {
    if (n.type === 'split') {
      addEdge(n.source_node, n.source_port, n.id, 'in');
    } else if (n.type === 'mix') {
      n.inputs.forEach((inp, idx) => {
        addEdge(inp.source_node, inp.source_port, n.id, `in_${idx}`, inp.gain);
      });
    } else if (n.type === 'pitch_speed') {
      // Target handle is in_{slot_id}, NOT in_{array_index} — handle IDs are
      // stable so downstream edges to out_{slot_id} don't break when the
      // inputs array is reordered or trimmed.
      n.inputs.forEach((inp) => {
        addEdge(inp.source_node, inp.source_port, n.id, `in_${inp.slot_id}`);
      });
    } else if (n.type === 'output') {
      addEdge(n.source_node, n.source_port, n.id, 'in');
    }
  }

  return { nodes, edges };
}

/**
 * Convert xyflow's state back into a GraphSpec.
 * Position updates live in flowNodes; node param edits live in flowNodes[].data.
 * The connection structure lives in flowEdges (needed for Mix input list).
 */
export function flowToSpec(flowNodes: FlowNode[], flowEdges: FlowEdge[]): GraphSpec {
  const nodes: NodeSpec[] = [];

  for (const fn of flowNodes) {
    const data = fn.data as unknown as NodeSpec;
    const base = {
      id: fn.id,
      position: { x: fn.position.x, y: fn.position.y },
    };

    if (data.type === 'source') {
      nodes.push({ ...data, ...base });
    } else if (data.type === 'split') {
      // Find the edge feeding this split
      const edge = flowEdges.find((e) => e.target === fn.id);
      nodes.push({
        ...data,
        ...base,
        source_node: edge?.source ?? data.source_node,
        source_port: edge?.sourceHandle ?? data.source_port,
      });
    } else if (data.type === 'mix') {
      const incoming = flowEdges
        .filter((e) => e.target === fn.id)
        .sort((a, b) => (a.targetHandle || '').localeCompare(b.targetHandle || ''));
      const existing = data.inputs ?? [];
      const inputs = incoming.map((e) => {
        const prev = existing.find(
          (inp) => inp.source_node === e.source && inp.source_port === (e.sourceHandle ?? 'out'),
        );
        return {
          source_node: e.source!,
          source_port: e.sourceHandle ?? 'out',
          gain: prev?.gain ?? (e.data as any)?.gain ?? 1.0,
        };
      });
      nodes.push({ ...data, ...base, inputs });
    } else if (data.type === 'pitch_speed') {
      // Sort by slot_id numerically — in_10 must come after in_2.
      const slotIdx = (h: string | null | undefined): number =>
        parseSlotHandle(h) ?? Number.MAX_SAFE_INTEGER;
      const incoming = flowEdges
        .filter((e) => e.target === fn.id)
        .sort((a, b) => slotIdx(a.targetHandle) - slotIdx(b.targetHandle));
      const inputs = incoming.map((e) => ({
        slot_id: slotIdx(e.targetHandle),
        source_node: e.source!,
        source_port: e.sourceHandle ?? 'out',
      }));
      nodes.push({ ...data, ...base, inputs });
    } else if (data.type === 'output') {
      const edge = flowEdges.find((e) => e.target === fn.id);
      nodes.push({
        ...data,
        ...base,
        source_node: edge?.source ?? data.source_node,
        source_port: edge?.sourceHandle ?? data.source_port,
      });
    }
  }

  return { nodes };
}
