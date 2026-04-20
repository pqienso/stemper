// Graph model — mirrors backend/graph/schema.py

export const STEM_NAMES_6S = ['vocals', 'other', 'piano', 'guitar', 'drums', 'bass'] as const;
export const STEM_NAMES_4S = ['vocals', 'drums', 'bass', 'other'] as const;
export type StemName = typeof STEM_NAMES_6S[number];

export const STEM_COLORS: Record<string, string> = {
  vocals: '#83a598',
  other: '#d3869b',
  piano: '#b8bb26',
  guitar: '#fe8019',
  drums: '#fb4934',
  bass: '#fabd2f',
};

export const MODEL_STEMS: Record<string, readonly string[]> = {
  htdemucs_6s: STEM_NAMES_6S,
  htdemucs: STEM_NAMES_4S,
  htdemucs_ft: STEM_NAMES_4S,
};

export type DemucsModel = 'htdemucs_6s' | 'htdemucs' | 'htdemucs_ft';

// ---- Node specs (serializable, matches backend) -----------------------

export interface NodePosition {
  x: number;
  y: number;
}

export interface SourceNodeSpec {
  type: 'source';
  id: string;
  position: NodePosition;
}

export interface SplitNodeSpec {
  type: 'split';
  id: string;
  position: NodePosition;
  source_node: string;
  source_port: string;
  model: DemucsModel;
  n_shifts: number;
  normalize_before: boolean;
  normalize_after: boolean;
  sample_rate: number;
  output_mono: boolean;
  seed: number;
}

export interface MixInputSpec {
  source_node: string;
  source_port: string;
  gain: number;
}

export interface MixNodeSpec {
  type: 'mix';
  id: string;
  position: NodePosition;
  inputs: MixInputSpec[];
}

export interface PitchSpeedInputSpec {
  // Stable id for this slot — decouples port identity from array index so
  // disconnecting one input doesn't renumber the others.
  slot_id: number;
  source_node: string;
  source_port: string;
}

export interface PitchSpeedNodeSpec {
  type: 'pitch_speed';
  id: string;
  position: NodePosition;
  inputs: PitchSpeedInputSpec[];
  // -24..+24 semitones; 0 = no shift
  pitch_semitones: number;
  // 0.25..4.0; 1.0 = original speed
  tempo_ratio: number;
}

export interface OutputNodeSpec {
  type: 'output';
  id: string;
  position: NodePosition;
  label: string;
  source_node: string;
  source_port: string;
}

export type NodeSpec = SourceNodeSpec | SplitNodeSpec | MixNodeSpec | PitchSpeedNodeSpec | OutputNodeSpec;

export interface GraphSpec {
  nodes: NodeSpec[];
}

// ---- Runtime status ---------------------------------------------------

export type NodeStatus = 'idle' | 'queued' | 'running' | 'cached' | 'done' | 'error';

export interface NodeRunState {
  status: NodeStatus;
  progress: number;
  stage: string;
  error?: string;
}

// ---- Preset --------------------------------------------------------------

export interface PresetMeta {
  id: string;
  name: string;
  description: string;
  graph: GraphSpec;
}

// ---- Helpers ------------------------------------------------------------

export const NODE_TYPE_COLOR: Record<string, string> = {
  source: '#fabd2f',
  split: '#83a598',
  mix: '#d3869b',
  pitch_speed: '#8ec07c',
  output: '#b8bb26',
};

export const DEFAULT_NODE_COLOR = '#a89984';

export function nodeTypeColor(t: string | undefined): string {
  return NODE_TYPE_COLOR[t ?? ''] ?? DEFAULT_NODE_COLOR;
}

// Handles are `in_{n}` / `out_{n}` on pitch_speed and `in_{n}` on mix.
// Returns the numeric suffix, or null for unprefixed handles like `out`/`in`.
export function parseSlotHandle(handle: string | null | undefined): number | null {
  const m = (handle ?? '').match(/^(?:in|out)_(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

export function stemsForModel(model: string): readonly string[] {
  return MODEL_STEMS[model] ?? STEM_NAMES_6S;
}

// Short random id for newly-created nodes / presets. Prefers crypto.randomUUID
// when available; falls back to a base36 timestamp + entropy for older browsers
// and non-secure contexts (http:// served over a LAN).
export function shortId(prefix: string, len = 6): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, len)
      : Math.random().toString(36).slice(2, 2 + len);
  return `${prefix}${rand}`;
}

export function validOutputPorts(node: NodeSpec): string[] {
  switch (node.type) {
    case 'source':
      return ['out'];
    case 'split':
      return [...stemsForModel(node.model)];
    case 'mix':
      return ['out'];
    case 'pitch_speed':
      return node.inputs.map((i) => `out_${i.slot_id}`);
    case 'output':
      return [];
  }
}

// Returns the (source_node_id, source_port) pairs this node reads from —
// mirror of _incoming_refs in backend/graph/schema.py.
export function incomingRefs(node: NodeSpec): Array<[string, string]> {
  switch (node.type) {
    case 'source':
      return [];
    case 'split':
    case 'output':
      return [[node.source_node, node.source_port]];
    case 'mix':
    case 'pitch_speed':
      return node.inputs.map((i) => [i.source_node, i.source_port]);
  }
}
