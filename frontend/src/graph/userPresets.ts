import type { GraphSpec, NodeSpec, PresetMeta } from './types';
import { shortId } from './types';

const STORAGE_KEY = 'stemper:user_presets';

// Runtime state (title, thumbnail, sourceStatus, etc.) is stuffed into the
// source node's flow data so the canvas can render it. flowToSpec spreads
// that data back, which would leak transient fields into saved presets.
// Rebuild each node from only its declared spec keys.
function sanitizeGraph(graph: GraphSpec): GraphSpec {
  const nodes: NodeSpec[] = graph.nodes.map((n) => {
    const base = { id: n.id, position: { x: n.position.x, y: n.position.y } };
    switch (n.type) {
      case 'source':
        return { type: 'source', ...base };
      case 'split':
        return {
          type: 'split',
          ...base,
          source_node: n.source_node,
          source_port: n.source_port,
          model: n.model,
          n_shifts: n.n_shifts,
          normalize_before: n.normalize_before,
          normalize_after: n.normalize_after,
          sample_rate: n.sample_rate,
          output_mono: n.output_mono,
          seed: n.seed,
        };
      case 'mix':
        return {
          type: 'mix',
          ...base,
          inputs: n.inputs.map((i) => ({
            source_node: i.source_node,
            source_port: i.source_port,
            gain: i.gain,
          })),
        };
      case 'pitch_speed':
        return {
          type: 'pitch_speed',
          ...base,
          inputs: n.inputs.map((i) => ({
            slot_id: i.slot_id,
            source_node: i.source_node,
            source_port: i.source_port,
          })),
          pitch_semitones: n.pitch_semitones,
          tempo_ratio: n.tempo_ratio,
        };
      case 'output':
        return {
          type: 'output',
          ...base,
          label: n.label,
          source_node: n.source_node,
          source_port: n.source_port,
        };
    }
  });
  return { nodes };
}

function newId(): string {
  return shortId('user:', 16);
}

export function loadUserPresets(): PresetMeta[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is PresetMeta =>
        p && typeof p.id === 'string' && typeof p.name === 'string' && p.graph && Array.isArray(p.graph.nodes),
    );
  } catch (e) {
    console.warn('[userPresets] failed to load, resetting', e);
    return [];
  }
}

function persist(list: PresetMeta[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function saveUserPreset(name: string, description: string, graph: GraphSpec): PresetMeta {
  const preset: PresetMeta = {
    id: newId(),
    name: name.trim() || 'Untitled preset',
    description: description.trim(),
    graph: sanitizeGraph(graph),
  };
  const list = loadUserPresets();
  list.push(preset);
  persist(list);
  return preset;
}

export function deleteUserPreset(id: string): void {
  const list = loadUserPresets().filter((p) => p.id !== id);
  persist(list);
}

export function updateUserPreset(
  id: string,
  patch: { name?: string; description?: string; graph?: GraphSpec },
): PresetMeta | null {
  const list = loadUserPresets();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const prev = list[idx];
  const next: PresetMeta = {
    ...prev,
    name: patch.name !== undefined ? patch.name.trim() || prev.name : prev.name,
    description: patch.description !== undefined ? patch.description.trim() : prev.description,
    graph: patch.graph !== undefined ? sanitizeGraph(patch.graph) : prev.graph,
  };
  list[idx] = next;
  persist(list);
  return next;
}

// Accepts either a single PresetMeta or a bare GraphSpec. Always assigns a
// fresh id so imports can't collide with existing saved presets.
export function importUserPreset(text: string, fallbackName: string): PresetMeta {
  const parsed = JSON.parse(text);
  let name = fallbackName;
  let description = '';
  let graph: GraphSpec;
  if (parsed && Array.isArray(parsed.nodes)) {
    graph = parsed as GraphSpec;
  } else if (parsed && parsed.graph && Array.isArray(parsed.graph.nodes)) {
    graph = parsed.graph as GraphSpec;
    if (typeof parsed.name === 'string') name = parsed.name;
    if (typeof parsed.description === 'string') description = parsed.description;
  } else {
    throw new Error('Not a valid preset or graph spec.');
  }
  return saveUserPreset(name, description, graph);
}

export function exportPresetJSON(preset: PresetMeta): string {
  return JSON.stringify(
    { name: preset.name, description: preset.description, graph: preset.graph },
    null,
    2,
  );
}
