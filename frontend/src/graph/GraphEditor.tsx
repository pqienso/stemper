import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type Connection,
  type CoordinateExtent,
  type Edge,
  type Node,
  type NodeTypes,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { SourceNode } from './nodes/SourceNode';
import { SplitNode } from './nodes/SplitNode';
import { MixNode } from './nodes/MixNode';
import { PitchSpeedNode } from './nodes/PitchSpeedNode';
import { OutputNode } from './nodes/OutputNode';
import { specToFlow, flowToSpec } from './convert';
import { validateGraph, wouldCreateCycle } from './validate';
import {
  runGraph,
  cancelGraph,
  outputAudioUrl,
  subscribeToJob,
  createJob,
  uploadJob,
} from './api';
import type { GraphSpec, NodeRunState, NodeStatus, PresetMeta } from './types';
import { stemsForModel, parseSlotHandle, nodeTypeColor, shortId } from './types';
import { useMultiPlayback, computeVolume, type TrackConfig } from './usePlayback';
import { Inspector } from './Inspector';
import { OutputZone } from './OutputZone';
import { TransportBar } from './TransportBar';
import type { MixSource } from './mixDownload';
import {
  loadUserPresets,
  saveUserPreset,
  deleteUserPreset,
  updateUserPreset,
  importUserPreset,
  exportPresetJSON,
} from './userPresets';
import { PresetsModal } from './PresetModals';
import { useGraphHistory } from './useGraphHistory';

const nodeTypes: NodeTypes = {
  source: SourceNode,
  split: SplitNode,
  mix: MixNode,
  pitch_speed: PitchSpeedNode,
  output: OutputNode,
};

const PRO_OPTIONS = { hideAttribution: true };
const FLOW_STYLE = { background: '#1d2021' };
const FIT_VIEW_OPTIONS = { padding: 0.2, minZoom: 0.1 };
const MINIMAP_STYLE = {
  background: '#282828',
  border: '1px solid #504945',
  width: 180,
  height: 120,
};
const CONTROLS_STYLE = { background: '#282828', border: '1px solid #504945' };
const DELETE_KEYS = ['Backspace', 'Delete'];
const miniMapNodeColor = (n: Node) => nodeTypeColor(n.type);

interface Props {
  initialGraph: GraphSpec;
  presets: PresetMeta[];
}

export interface SourceState {
  title: string;
  thumbnail: string | null;
  status: 'empty' | 'downloading' | 'ready' | 'error';
  progress: number;
  stage: string;
  error: string | null;
}

const EMPTY_SOURCE: SourceState = {
  title: '',
  thumbnail: null,
  status: 'empty',
  progress: 0,
  stage: '',
  error: null,
};

const NODE_WIDTH = 90;
const ZONE_MARGIN = 30;
const PITCH_COLUMN_OFFSET = 30;        // pitch_speed column X = zoneX + this
const OUTPUT_COLUMN_OFFSET = 210;      // output column X = zoneX + this (room for pitch_speed)
const OUTPUT_ROW_STEP = 110;           // vertical spacing between output rows
const OUTPUT_NODE_HEIGHT = 90;         // output node's own rendered height
const OUTPUT_ROW_OFFSET = (OUTPUT_ROW_STEP - OUTPUT_NODE_HEIGHT) / 2;  // centers node in row

// pitch_speed and outputs both live inside the no-edit zone, so exclude them
// from the boundary calculation. Otherwise they'd push zoneX right on every
// recompute and drift out of alignment.
function computeZoneX(nodes: Array<{ type?: string; position: { x: number; y: number } }>): number {
  const xs = nodes
    .filter((n) => n.type !== 'output' && n.type !== 'pitch_speed')
    .map((n) => n.position.x + NODE_WIDTH);
  return xs.length ? Math.max(...xs) + ZONE_MARGIN : 400;
}

function outputExtent(zoneX: number): CoordinateExtent {
  // Outputs must be at x >= zoneX
  return [[zoneX, -10000], [10000, 10000]];
}

function nonOutputExtent(zoneX: number): CoordinateExtent {
  // Non-output nodes must fully fit LEFT of the zone. xyflow's clampPosition
  // already subtracts node width from extent[1][0], so the max is just zoneX.
  return [[-10000, -10000], [zoneX, 10000]];
}

function columnX(zoneX: number): number {
  return zoneX + OUTPUT_COLUMN_OFFSET;
}

function pitchColumnX(zoneX: number): number {
  return zoneX + PITCH_COLUMN_OFFSET;
}

function snapY(y: number): number {
  return Math.round((y - OUTPUT_ROW_OFFSET) / OUTPUT_ROW_STEP) * OUTPUT_ROW_STEP + OUTPUT_ROW_OFFSET;
}

// Lay all output nodes out as a vertical column. Snaps each output to the
// nearest grid row based on its incoming y, preserving the preset's vertical
// spacing/gaps. On collision, bumps the later (in sorted order) occupant
// down to the next free row.
function layoutOutputColumn<N extends { id: string; type?: string; position: { x: number; y: number } }>(
  nodes: N[],
  zoneX: number,
): N[] {
  const outs = nodes.filter((n) => n.type === 'output');
  const snapped = outs
    .map((n) => ({
      id: n.id,
      origY: n.position.y,
      row: Math.round((n.position.y - OUTPUT_ROW_OFFSET) / OUTPUT_ROW_STEP),
    }))
    .sort((a, b) => a.row - b.row || a.origY - b.origY);
  let lastRow = -Infinity;
  const posById = new Map<string, { x: number; y: number }>();
  for (const s of snapped) {
    const row = Math.max(s.row, lastRow + 1);
    lastRow = row;
    posById.set(s.id, { x: columnX(zoneX), y: row * OUTPUT_ROW_STEP + OUTPUT_ROW_OFFSET });
  }
  return nodes.map((n) =>
    posById.has(n.id) ? ({ ...n, position: posById.get(n.id)! } as N) : n,
  );
}

function GraphEditorInner({ initialGraph, presets }: Props) {
  const initZoneX = useMemo(() => computeZoneX(initialGraph.nodes), [initialGraph]);
  const { nodes: initNodes, edges: initEdges } = useMemo(() => {
    const { nodes, edges } = specToFlow(initialGraph);
    const outExt = outputExtent(initZoneX);
    const otherExt = nonOutputExtent(initZoneX);
    const withExtent = nodes.map((n) => {
      if (n.type === 'output') return { ...n, extent: outExt };
      if (n.type === 'pitch_speed') {
        return { ...n, extent: outExt, position: { x: pitchColumnX(initZoneX), y: n.position.y } };
      }
      return { ...n, extent: otherExt };
    });
    return {
      nodes: layoutOutputColumn(withExtent, initZoneX),
      edges,
    };
  }, [initialGraph, initZoneX]);

  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<Node>(initNodes);
  const [edges, setEdges, onEdgesChangeRaw] = useEdgesState<Edge>(initEdges);
  const nodesRef = useRef<Node[]>(initNodes);
  nodesRef.current = nodes;
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeRunState>>({});
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [outputs, setOutputs] = useState<Record<string, { label: string; hash: string }>>({});
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initialGraph.nodes.find((n) => n.type === 'source')?.id ?? null,
  );
  const [presetLoadKey, setPresetLoadKey] = useState(0);
  const [userPresets, setUserPresets] = useState<PresetMeta[]>(() => loadUserPresets());
  const [presetsModalOpen, setPresetsModalOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [sourceState, setSourceState] = useState<SourceState>(EMPTY_SOURCE);
  const [zoneX, setZoneX] = useState(initZoneX);
  const unsubRef = useRef<(() => void) | null>(null);
  const playback = useMultiPlayback();
  const { fitView } = useReactFlow();

  // ---- Undo/redo history -------------------------------------------------
  //
  // suppressHistoryRef gates the two derivation effects (edge-validity
  // cleanup and output derivation) during an undo/redo restore, so the
  // restored state isn't immediately re-pruned or re-derived into something
  // different. dragInFlightRef throttles per-pixel drag ticks into a single
  // history entry (snapshot at drag-start, not at every position change).
  const suppressHistoryRef = useRef(false);
  const dragInFlightRef = useRef(false);
  const history = useGraphHistory({
    nodes, edges, zoneX, setNodes, setEdges, setZoneX,
    suppressRef: suppressHistoryRef,
  });

  // ---- Fake/real progress combiner for source load -----------------------
  //
  // On URL submit (handleSourceFromUrl) or file select (handleSourceFromFile),
  // a fake ramp (targeting FAKE_MAX over FAKE_DURATION_MS) animates from 0
  // so the user sees motion from the moment they commit — before any bytes
  // have flowed.
  //
  // The tricky part is the handoff from fake → real. Uploads fire their
  // first XHR onprogress event almost immediately, so naively scaling
  // `real 0-100 → FAKE_MAX-100` would *snap* the bar from ~1% (fake in
  // flight) up to FAKE_MAX. Instead we anchor: the first time real > 0,
  // we freeze the current fake pct as the anchor and scale real into
  // `[anchor..100]`. That way slow starts (URL downloads where metadata
  // takes seconds) still land at FAKE_MAX, but fast starts (uploads where
  // bytes fly immediately) continue from wherever the fake ramp got to —
  // no visible jump.
  const FAKE_DURATION_MS = 3000;
  const FAKE_MAX = 20;
  const fakeTimerRef = useRef<number | null>(null);
  const fakeStartRef = useRef<number>(0);
  const realPctRef = useRef<number>(0);
  const anchorRef = useRef<number>(-1);

  const applyProgress = useCallback(() => {
    const elapsed = performance.now() - fakeStartRef.current;
    const fakePct = Math.min(FAKE_MAX, (elapsed / FAKE_DURATION_MS) * FAKE_MAX);

    // On the first tick where real progress is >0, lock in the current
    // fake pct as the anchor. Subsequent ticks scale real into [anchor..100]
    // so the transition is continuous.
    if (realPctRef.current > 0 && anchorRef.current < 0) {
      anchorRef.current = fakePct;
    }

    const anchor = anchorRef.current < 0 ? FAKE_MAX : anchorRef.current;
    const realScaled =
      realPctRef.current > 0
        ? anchor + (realPctRef.current * (100 - anchor)) / 100
        : 0;

    const pct = Math.max(fakePct, realScaled);
    setSourceState((prev) => ({ ...prev, progress: Math.max(prev.progress, pct) }));
  }, []);

  const startFakeProgress = useCallback(() => {
    if (fakeTimerRef.current != null) window.clearInterval(fakeTimerRef.current);
    fakeStartRef.current = performance.now();
    realPctRef.current = 0;
    anchorRef.current = -1;  // reset for a fresh upload/download cycle
    applyProgress();  // fire immediately — don't wait 100ms for the first tick
    fakeTimerRef.current = window.setInterval(applyProgress, 100);
  }, [applyProgress]);

  const stopFakeProgress = useCallback(() => {
    if (fakeTimerRef.current != null) {
      window.clearInterval(fakeTimerRef.current);
      fakeTimerRef.current = null;
    }
  }, []);

  // Keyboard handler for Ctrl-Z / Ctrl-Shift-Z / Ctrl-Y.
  // Guards against firing while focus is inside Inspector text fields so the
  // browser's native field-level undo keeps working for typing. Outside of
  // inputs, it walks the graph history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.matches('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        history.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        history.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history]);


  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) =>
        n.type === 'source'
          ? { ...n, data: { ...n.data, title: sourceState.title, thumbnail: sourceState.thumbnail, sourceStatus: sourceState.status, sourceProgress: sourceState.progress / 100 } }
          : n,
      ),
    );
  }, [sourceState.title, sourceState.thumbnail, sourceState.status, sourceState.progress, setNodes]);

  useEffect(() => {
    const outExt = outputExtent(zoneX);
    const otherExt = nonOutputExtent(zoneX);
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type === 'output') return { ...n, extent: outExt };
        if (n.type === 'pitch_speed') {
          return { ...n, extent: outExt, position: { x: pitchColumnX(zoneX), y: n.position.y } };
        }
        return { ...n, extent: otherExt };
      }),
    );
  }, [zoneX, setNodes]);

  // Prune edges whose source_port is no longer valid on the source node.
  // Only covers source / split / mix: split's ports shrink on a 6→4-stem
  // switch; source/mix just guard against accidental "out_N"-style handles.
  // pitch_speed is excluded on purpose — its valid out-ports are defined by
  // its incoming edges, and the output-derivation effect below is the single
  // source of truth for that chain.
  useEffect(() => {
    if (suppressHistoryRef.current) return;
    const invalidEdgeIds = new Set<string>();
    const mixInputsToDrop = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!e.sourceHandle) continue;
      const src = nodes.find((n) => n.id === e.source);
      if (!src) continue;
      let valid = true;
      if (src.type === 'source') valid = e.sourceHandle === 'out';
      else if (src.type === 'mix') valid = e.sourceHandle === 'out';
      else if (src.type === 'split') {
        valid = stemsForModel((src.data as any).model).includes(e.sourceHandle);
      } else {
        continue;  // pitch_speed handled elsewhere
      }
      if (valid) continue;
      invalidEdgeIds.add(e.id);
      const t = nodes.find((n) => n.id === e.target);
      if (t?.type === 'mix') {
        const key = `${e.source}.${e.sourceHandle}`;
        if (!mixInputsToDrop.has(t.id)) mixInputsToDrop.set(t.id, new Set());
        mixInputsToDrop.get(t.id)!.add(key);
      }
    }
    if (invalidEdgeIds.size === 0) return;
    setEdges((prev) => prev.filter((e) => !invalidEdgeIds.has(e.id)));
    if (mixInputsToDrop.size > 0) {
      setNodes((prev) => prev.map((n) => {
        if (n.type !== 'mix' || !mixInputsToDrop.has(n.id)) return n;
        const drop = mixInputsToDrop.get(n.id)!;
        const d = n.data as any;
        const oldInputs = Array.isArray(d.inputs) ? d.inputs : [];
        const newInputs = oldInputs.filter(
          (inp: any) => !drop.has(`${inp.source_node}.${inp.source_port}`),
        );
        return { ...n, data: { ...d, inputs: newInputs } };
      }));
    }
  }, [nodes, edges, setNodes, setEdges]);

  // Outputs are strictly a function of pitch_speed's incoming edges: one
  // Output per connected input slot, wired pitch_speed.out_{sid} -> output.in.
  // Handles both directions in a single pass:
  //   - Live slot with no Output   -> create Output + edge
  //   - Output whose slot is dead  -> remove Output + edge
  // So split-model shrinkage, user disconnecting an input, or user wiring a
  // new one all resolve through this one effect. Labels derive from the
  // upstream source_port (falling back to source node id when generic).
  useEffect(() => {
    if (suppressHistoryRef.current) return;
    const ps = nodes.find((n) => n.type === 'pitch_speed');
    if (!ps) return;

    const liveSlots = new Set<number>();
    const inEdgeBySlot = new Map<number, Edge>();
    for (const e of edges) {
      if (e.target !== ps.id) continue;
      const sid = parseSlotHandle(e.targetHandle);
      if (sid === null) continue;
      liveSlots.add(sid);
      inEdgeBySlot.set(sid, e);
    }

    const outputBySlot = new Map<number, Node>();
    const outEdgeBySlot = new Map<number, Edge>();
    for (const e of edges) {
      if (e.source !== ps.id || !e.sourceHandle) continue;
      const sid = parseSlotHandle(e.sourceHandle);
      if (sid === null) continue;
      const t = nodes.find((n) => n.id === e.target);
      if (t?.type !== 'output') continue;
      outputBySlot.set(sid, t);
      outEdgeBySlot.set(sid, e);
    }

    const toAddSlots = Array.from(liveSlots)
      .filter((sid) => !outputBySlot.has(sid))
      .sort((a, b) => a - b);
    const toRemoveNodeIds = new Set<string>();
    const toRemoveEdgeIds = new Set<string>();
    for (const [sid, outNode] of outputBySlot) {
      if (liveSlots.has(sid)) continue;
      toRemoveNodeIds.add(outNode.id);
      const edge = outEdgeBySlot.get(sid);
      if (edge) toRemoveEdgeIds.add(edge.id);
    }

    if (toAddSlots.length === 0 && toRemoveNodeIds.size === 0) return;

    const existingYs = nodes
      .filter((n) => n.type === 'output' && !toRemoveNodeIds.has(n.id))
      .map((n) => n.position.y);
    let nextY = existingYs.length ? Math.max(...existingYs) + OUTPUT_ROW_STEP : OUTPUT_ROW_OFFSET;

    const outExt = outputExtent(zoneX);
    const toAddNodes: Node[] = [];
    const toAddEdges: Edge[] = [];
    const usedLabels = new Set(
      nodes
        .filter((n) => n.type === 'output' && !toRemoveNodeIds.has(n.id))
        .map((n) => (n.data as any).label as string),
    );

    for (const sid of toAddSlots) {
      const inEdge = inEdgeBySlot.get(sid);
      let baseLabel = `out_${sid}`;
      if (inEdge?.sourceHandle) {
        const sp = inEdge.sourceHandle;
        baseLabel = sp === 'out' || /^out_\d+$/.test(sp)
          ? (inEdge.source ?? baseLabel)
          : sp;
      }
      let label = baseLabel;
      let suffix = 2;
      while (usedLabels.has(label)) {
        label = `${baseLabel}_${suffix}`;
        suffix += 1;
      }
      usedLabels.add(label);

      const id = shortId(`output_${sid}_`, 4);
      const position = { x: columnX(zoneX), y: nextY };
      nextY += OUTPUT_ROW_STEP;

      toAddNodes.push({
        id,
        type: 'output',
        extent: outExt,
        position,
        deletable: false,
        data: {
          type: 'output', id,
          position,
          label,
          source_node: ps.id,
          source_port: `out_${sid}`,
        },
      });
      toAddEdges.push({
        id: `${ps.id}:out_${sid}->${id}:in`,
        source: ps.id,
        sourceHandle: `out_${sid}`,
        target: id,
        targetHandle: 'in',
        animated: false,
        style: { stroke: '#a89984', strokeWidth: 4 },
        interactionWidth: 30,
        deletable: false,
      });
    }

    setNodes((prev) => {
      const kept = prev.filter((n) => !toRemoveNodeIds.has(n.id));
      return toAddNodes.length > 0 ? layoutOutputColumn([...kept, ...toAddNodes], zoneX) : kept;
    });
    setEdges((prev) => {
      const kept = prev.filter((e) => !toRemoveEdgeIds.has(e.id));
      return toAddEdges.length > 0 ? [...kept, ...toAddEdges] : kept;
    });
  }, [nodes, edges, zoneX, setNodes, setEdges]);

  // SSE subscription for the current job
  useEffect(() => {
    if (!jobId) return;
    const unsub = subscribeToJob(jobId, (event) => {
      if (event.type === 'node') {
        setNodeStatus((prev) => ({
          ...prev,
          [event.node_id]: {
            status: event.status as NodeStatus,
            progress: event.progress ?? 0,
            stage: event.stage ?? '',
          },
        }));
      } else if (event.type === 'run') {
        if (event.status === 'running') setRunStatus('running');
        else if (event.status === 'done') {
          setRunStatus('done');
          const outMap: Record<string, { label: string; hash: string }> = {};
          (event.outputs ?? []).forEach((o: any) => {
            outMap[o.node_id] = { label: o.label, hash: o.hash };
          });
          setOutputs(outMap);
        } else if (event.status === 'error') {
          setRunStatus('error');
          console.warn('run error:', event.error);
        } else if (event.status === 'cancelled') {
          setRunStatus('idle');
        }
      } else if (event.type === 'job' || event.type === 'info' || event.type === 'snapshot') {
        // Feed real download progress into the combiner (doesn't short-circuit
        // the fake ramp — both are Math.max'd inside applyProgress).
        if (typeof event.progress === 'number' && event.progress > 0) {
          realPctRef.current = Math.max(realPctRef.current, event.progress);
        }
        if (event.status === 'ready') {
          stopFakeProgress();
          realPctRef.current = 100;
        } else if (event.status === 'error') {
          stopFakeProgress();
        }
        setSourceState((prev) => ({
          ...prev,
          title: event.title ?? prev.title,
          thumbnail: event.thumbnail ?? prev.thumbnail,
          stage: event.stage ?? prev.stage,
          status:
            event.status === 'ready'
              ? 'ready'
              : event.status === 'error'
              ? 'error'
              : event.status === 'downloading'
              ? 'downloading'
              : prev.status,
          error: event.error ?? null,
        }));
        applyProgress();
      }
    });
    unsubRef.current = unsub;
    return () => unsub();
  }, [jobId]);

  // Register audio tracks with the multi-track player whenever outputs change
  useEffect(() => {
    if (!jobId) {
      playback.setTracks([]);
      return;
    }
    const tracks: TrackConfig[] = Object.keys(outputs).map((nodeId) => ({
      nodeId,
      url: outputAudioUrl(jobId, nodeId),
    }));
    playback.setTracks(tracks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputs, jobId]);

  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        data: {
          ...n.data,
          status: nodeStatus[n.id]?.status ?? 'idle',
          progress: (nodeStatus[n.id]?.progress ?? 0) / 100,
        },
      })),
    );
  }, [nodeStatus, setNodes]);

  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type !== 'output') return n;
        const hasResult = !!outputs[n.id];
        const muted = playback.mutes.has(n.id);
        const soloed = playback.solos.has(n.id);
        return {
          ...n,
          data: {
            ...n.data,
            hasResult,
            muted,
            soloed,
            onToggleMute: hasResult ? () => playback.toggleMute(n.id) : undefined,
            onToggleSolo: hasResult ? () => playback.toggleSolo(n.id) : undefined,
          },
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputs, playback.mutes, playback.solos]);

  // Block user-drawn edges into Output nodes. Outputs are managed exclusively
  // by the output-derivation effect (one per pitch_speed input slot), and
  // letting a user wire a second edge into an Output spawns a duplicate row
  // in layoutOutputColumn and confuses the derivation bookkeeping.
  const isValidConnection = useCallback((conn: Edge | Connection) => {
    const target = nodesRef.current.find((n) => n.id === conn.target);
    if (target?.type === 'output') return false;
    return true;
  }, []);

  const onConnect = useCallback((params: Connection) => {
    // Second line of defense in case isValidConnection is bypassed (e.g. a
    // programmatic connection path that doesn't go through the validator).
    const target = nodesRef.current.find((n) => n.id === params.target);
    if (target?.type === 'output') return;

    if (params.source && params.target && wouldCreateCycle(edges, params.source, params.target)) {
      console.warn('Rejecting cycle-introducing edge', params);
      return;
    }
    history.pushSnapshot();
    setEdges((prev) => {
      const filtered = prev.filter(
        (e) => !(e.target === params.target && e.targetHandle === params.targetHandle),
      );
      return addEdge(
        {
          ...params,
          animated: false,
          style: { stroke: '#a89984', strokeWidth: 4 },
          interactionWidth: 30,
        },
        filtered,
      );
    });
  }, [edges, setEdges, history]);

  const spec = useMemo(() => flowToSpec(nodes, edges), [nodes, edges]);
  const validation = useMemo(() => validateGraph(spec), [spec]);

  // Graph signature for change detection: captures structural + param edits
  // while ignoring positions and runtime fields (status, progress, etc.).
  // `spec.nodes[i]` has runtime fields stashed via node.data — we read only
  // the typed NodeSpec fields via the discriminant so extras are ignored.
  const graphSignature = useMemo(() => {
    const parts = spec.nodes.map((n) => {
      switch (n.type) {
        case 'source':
          return `source:${n.id}`;
        case 'split':
          return `split:${n.id}:${n.source_node}:${n.source_port}:${n.model}:${n.n_shifts}:${n.normalize_before}:${n.normalize_after}:${n.sample_rate}:${n.output_mono}:${n.seed}`;
        case 'mix':
          return `mix:${n.id}:[${n.inputs.map((i) => `${i.source_node}.${i.source_port}@${i.gain}`).join(',')}]`;
        case 'pitch_speed':
          return `pitch_speed:${n.id}:${n.pitch_semitones}:${n.tempo_ratio}:[${n.inputs.map((i) => `${i.slot_id}=${i.source_node}.${i.source_port}`).join(',')}]`;
        case 'output':
          return `output:${n.id}:${n.source_node}:${n.source_port}:${n.label}`;
      }
    });
    return parts.sort().join('|');
  }, [spec]);

  // On any structural or param change, drain node fills by clearing their
  // run status. Skip the initial mount so presets don't flash-drain on load.
  const prevSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSigRef.current !== null && prevSigRef.current !== graphSignature) {
      setNodeStatus({});
    }
    prevSigRef.current = graphSignature;
  }, [graphSignature]);

  // Intercept position changes for output nodes: force x = columnX and snap y
  // to the row grid BEFORE xyflow's drag bookkeeping applies them. Patching on
  // the way in (rather than overwriting after drag-stop) avoids the state race
  // that left the node stuck to the cursor.
  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    // History: push ONCE at drag-start (first position change with
    // dragging === true) so moving a node by 200px becomes one undo entry
    // instead of ~200. Any remove-change (Backspace/Delete) also pushes.
    const hasDragStart = changes.some(
      (c) => c.type === 'position' && c.dragging === true,
    );
    const hasDragEnd = changes.some(
      (c) => c.type === 'position' && c.dragging === false,
    );
    const hasRemove = changes.some((c) => c.type === 'remove');
    if (hasDragStart && !dragInFlightRef.current) {
      dragInFlightRef.current = true;
      history.pushSnapshot();
    }
    if (hasDragEnd) dragInFlightRef.current = false;
    if (hasRemove) history.pushSnapshot();

    // Output snap-to-grid is live-collision-aware: whenever the dragged
    // output's snapped row is already occupied, we push the occupant to the
    // dragged node's previous row in the same tick, so two outputs never
    // visually overlap (not even mid-drag). Swaps are applied via setNodes
    // after xyflow processes the standard changes.
    const swaps: Array<{ id: string; y: number }> = [];
    const patched = changes.map((c) => {
      if (c.type === 'position' && c.position) {
        const node = nodesRef.current.find((n) => n.id === c.id);
        if (node?.type === 'output') {
          const newY = snapY(c.position.y);
          const prevY = node.position.y;
          if (newY !== prevY) {
            const occupant = nodesRef.current.find(
              (n) => n.type === 'output' && n.id !== c.id && n.position.y === newY,
            );
            if (occupant) swaps.push({ id: occupant.id, y: prevY });
          }
          return {
            ...c,
            position: { x: columnX(zoneX), y: newY },
          };
        }
        if (node?.type === 'pitch_speed') {
          return {
            ...c,
            position: { x: pitchColumnX(zoneX), y: c.position.y },
          };
        }
      }
      return c;
    });
    onNodesChangeRaw(patched);
    if (swaps.length) {
      setNodes((prev) =>
        prev.map((n) => {
          const swap = swaps.find((s) => s.id === n.id);
          return swap ? { ...n, position: { ...n.position, y: swap.y } } : n;
        }),
      );
    }
  }, [zoneX, onNodesChangeRaw, setNodes, history]);

  // Wrap onEdgesChange so keyboard-deleting an edge pushes a history entry.
  // Edge remove is the only user-driven edge change xyflow's hook surfaces
  // here — user-drawn connects go through onConnect (already instrumented).
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const hasRemove = changes.some((c) => c.type === 'remove');
    if (hasRemove) history.pushSnapshot();
    onEdgesChangeRaw(changes);
  }, [onEdgesChangeRaw, history]);

  const anyOutputReady = Object.keys(outputs).length > 0;

  const mixSources = useMemo<MixSource[]>(() => {
    if (!jobId) return [];
    return Object.keys(outputs).map((nodeId) => ({
      url: outputAudioUrl(jobId, nodeId),
      volume: computeVolume(nodeId, playback.mutes, playback.solos),
    }));
  }, [jobId, outputs, playback.mutes, playback.solos]);

  // Cap how far right the viewport can pan — stop just past the output column.
  const translateExtent = useMemo<CoordinateExtent>(() => {
    const outRightEdge = columnX(zoneX) + NODE_WIDTH;  // rightmost pixel of any output
    return [[-10000, -10000], [outRightEdge + 360, 10000]];
  }, [zoneX]);

  const loadPreset = (preset: PresetMeta) => {
    const newZone = computeZoneX(preset.graph.nodes);
    const { nodes: pn, edges: pe } = specToFlow(preset.graph);
    const outExt = outputExtent(newZone);
    const otherExt = nonOutputExtent(newZone);
    const withExtent = pn.map((n) => {
      if (n.type === 'source') {
        return {
          ...n,
          extent: otherExt,
          data: { ...n.data, title: sourceState.title, thumbnail: sourceState.thumbnail, sourceStatus: sourceState.status },
        };
      }
      if (n.type === 'output') return { ...n, extent: outExt };
      if (n.type === 'pitch_speed') {
        return { ...n, extent: outExt, position: { x: pitchColumnX(newZone), y: n.position.y } };
      }
      return { ...n, extent: otherExt };
    });
    setZoneX(newZone);
    setNodes(layoutOutputColumn(withExtent, newZone));
    setEdges(pe);
    setNodeStatus({});
    setOutputs({});
    setRunStatus('idle');
    setSelectedId(preset.graph.nodes.find((n) => n.type === 'source')?.id ?? null);
    setPresetLoadKey((k) => k + 1);
    // A preset load fundamentally replaces the graph; undoing into the prior
    // preset's universe would mix incompatible source/split/pitch_speed
    // identities. Clear history so Ctrl-Z after a preset load is a no-op.
    history.clear();
    // Re-center after React has applied the new nodes
    setTimeout(() => fitView({ padding: 0.2, minZoom: 0.1, duration: 300 }), 0);
  };

  const handleSourceFromUrl = async (url: string) => {
    setSourceState({ ...EMPTY_SOURCE, status: 'downloading', stage: 'submitting' });
    setOutputs({});
    setNodeStatus({});
    unsubRef.current?.();
    // Kick the fake ramp the instant Enter is pressed — before createJob
    // even returns — so the user sees motion immediately.
    startFakeProgress();
    try {
      const { job_id } = await createJob(url);
      setJobId(job_id);
    } catch (e: any) {
      stopFakeProgress();
      setSourceState({
        ...EMPTY_SOURCE,
        status: 'error',
        error: e?.message ?? 'Failed to create job',
      });
    }
  };

  const handleSourceFromFile = async (file: File) => {
    setSourceState({ ...EMPTY_SOURCE, status: 'downloading', stage: 'uploading', title: file.name });
    setOutputs({});
    setNodeStatus({});
    unsubRef.current?.();
    startFakeProgress();
    try {
      const { job_id } = await uploadJob(file, (pct) => {
        // Feed XHR upload progress into the shared combiner, then force an
        // immediate tick so the phase-2 transition doesn't wait for the next
        // 100ms timer fire.
        realPctRef.current = Math.max(realPctRef.current, pct);
        applyProgress();
      });
      setJobId(job_id);
    } catch (e: any) {
      stopFakeProgress();
      setSourceState({
        ...EMPTY_SOURCE,
        status: 'error',
        title: file.name,
        error: e?.message ?? 'Failed to upload file',
      });
    }
  };

  const handleResetSource = () => {
    unsubRef.current?.();
    stopFakeProgress();
    setJobId(null);
    setSourceState(EMPTY_SOURCE);
    setOutputs({});
    setNodeStatus({});
    setRunStatus('idle');
  };

  const onRun = async () => {
    if (!validation.ok || !jobId) return;
    try {
      setRunStatus('running');
      setNodeStatus({});
      setOutputs({});
      await runGraph(jobId, spec);
    } catch (e: any) {
      setRunStatus('error');
      console.warn('run failed:', e.message ?? e);
    }
  };

  const onCancel = async () => {
    if (!jobId) return;
    // Optimistic flip — the server's SSE "cancelled" event also sets this,
    // but doing it here makes the UI feel instantaneous even before the
    // executor thread unwinds.
    setRunStatus('idle');
    try {
      await cancelGraph(jobId);
    } catch (e: any) {
      console.warn('cancel failed:', e.message ?? e);
    }
  };

  const addNode = (type: 'split' | 'mix') => {
    const id = shortId(`${type}_`, 6);
    const spawnX = Math.min(400 + Math.random() * 200, zoneX - NODE_WIDTH - 20);
    const base = {
      id,
      position: { x: spawnX, y: 200 + Math.random() * 200 },
    };
    const otherExt = nonOutputExtent(zoneX);
    let node: Node;
    if (type === 'split') {
      node = {
        ...base,
        type: 'split',
        extent: otherExt,
        data: {
          type: 'split', id,
          position: base.position,
          source_node: '', source_port: 'out',
          model: 'htdemucs_6s',
          n_shifts: 2,
          normalize_before: false, normalize_after: false,
          sample_rate: 44100, output_mono: false, seed: 0,
        },
      };
    } else {
      node = {
        ...base,
        type: 'mix',
        extent: otherExt,
        data: { type: 'mix', id, position: base.position, inputs: [] },
      };
    }
    history.pushSnapshot();
    setNodes((prev) => [...prev, node]);
    setSelectedId(id);
  };

  const sourceReady = sourceState.status === 'ready';

  return (
    <div className="h-full w-full flex flex-col bg-gruvbox-bg-h">
      <div className="border-b border-gruvbox-bg2 px-5 py-4 flex items-center gap-4 bg-gruvbox-bg">
        <h1 className="text-3xl font-black text-gruvbox-fg leading-none shrink-0 tracking-tighter" style={{ WebkitTextStroke: '0.5px currentColor' }}>stemper</h1>

        <div className="w-px h-7 bg-gruvbox-bg2" />

        <div className="flex gap-1.5">
          <button
            onClick={() => addNode('split')}
            title="add Split"
            className="px-2.5 py-2 text-[13px] rounded border border-gruvbox-blue/50 text-gruvbox-blue hover:bg-gruvbox-blue/10 inline-flex items-center gap-1"
          >
            <span className="leading-none">+</span>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4" cy="12" r="1.6" />
              <circle cx="20" cy="4" r="1.6" />
              <circle cx="20" cy="12" r="1.6" />
              <circle cx="20" cy="20" r="1.6" />
              <path d="M5.5 12 L18.5 4 M5.5 12 H18.5 M5.5 12 L18.5 20" fill="none" />
            </svg>
          </button>
          <button
            onClick={() => addNode('mix')}
            title="add Mix"
            className="px-2.5 py-2 text-[13px] rounded border border-gruvbox-purple/50 text-gruvbox-purple hover:bg-gruvbox-purple/10 inline-flex items-center gap-1"
          >
            <span className="leading-none">+</span>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4" cy="4" r="1.6" />
              <circle cx="4" cy="12" r="1.6" />
              <circle cx="4" cy="20" r="1.6" />
              <circle cx="20" cy="12" r="1.6" />
              <path d="M5.5 4 L18.5 12 M5.5 12 H18.5 M5.5 20 L18.5 12" fill="none" />
            </svg>
          </button>
        </div>

        <button
          onClick={() => {
            const json = JSON.stringify(spec, null, 2);
            console.log(json);
            navigator.clipboard?.writeText(json).catch(() => {});
          }}
          title="copy the current graph spec as JSON (console + clipboard)"
          className="px-3 py-1.5 text-[13px] rounded bg-gruvbox-bg1 text-gruvbox-fg3
                     hover:bg-gruvbox-bg2 hover:text-gruvbox-fg border border-gruvbox-bg2"
        >
          {'{ } copy json'}
        </button>

        <div className="flex-1" />

        <button
          onClick={() => setPresetsModalOpen(true)}
          className="px-4 py-2 text-[13px] font-bold uppercase tracking-wider rounded-md
                     bg-gruvbox-orange text-gruvbox-bg-h shadow-lg shadow-gruvbox-orange/30
                     hover:brightness-110 hover:shadow-gruvbox-orange/50 transition-all
                     inline-flex items-center gap-2"
        >
          Presets
        </button>
      </div>

      {presetsModalOpen && (
        <PresetsModal
          builtIn={presets}
          saved={userPresets}
          currentGraph={spec}
          onClose={() => setPresetsModalOpen(false)}
          onLoad={(p) => {
            loadPreset(p);
            setPresetsModalOpen(false);
          }}
          onSave={(name, description) => {
            saveUserPreset(name, description, spec);
            setUserPresets(loadUserPresets());
          }}
          onUpdate={(id, patch) => {
            updateUserPreset(id, patch);
            setUserPresets(loadUserPresets());
          }}
          onDelete={(id) => {
            deleteUserPreset(id);
            setUserPresets(loadUserPresets());
          }}
          onExport={(p) => {
            const json = exportPresetJSON(p);
            navigator.clipboard?.writeText(json).catch(() => {});
          }}
          onImport={(text) => {
            importUserPreset(text, 'Imported preset');
            setUserPresets(loadUserPresets());
          }}
        />
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={DELETE_KEYS}
            translateExtent={translateExtent}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={0.1}
            proOptions={PRO_OPTIONS}
            style={FLOW_STYLE}
          >
            <Background color="#3c3836" variant={BackgroundVariant.Dots} gap={20} size={1} />
            <OutputZone zoneX={zoneX} rowStep={OUTPUT_ROW_STEP} />
            <Controls className="!bg-gruvbox-bg !border-gruvbox-bg2" style={CONTROLS_STYLE} />
            <MiniMap
              position="top-left"
              pannable zoomable
              nodeColor={miniMapNodeColor}
              maskColor="rgba(29,32,33,0.7)"
              style={MINIMAP_STYLE}
            />
          </ReactFlow>
        </div>

        <Inspector
          selectedId={selectedId}
          nodes={nodes}
          edges={edges}
          jobId={jobId}
          outputs={outputs}
          outputAudioUrl={outputAudioUrl}
          onClose={() => setSelectedId(null)}
          sourceState={sourceState}
          onSourceFromUrl={handleSourceFromUrl}
          onSourceFromFile={handleSourceFromFile}
          onResetSource={handleResetSource}
          onRun={onRun}
          onCancel={onCancel}
          runDisabled={runStatus === 'running' ? false : (!sourceReady || !validation.ok)}
          runStatus={runStatus}
          presetLoadKey={presetLoadKey}
          onBeforeEdit={history.pushDebounced}
        />
      </div>

      <TransportBar
        isPlaying={playback.isPlaying}
        currentTime={playback.currentTime}
        duration={playback.duration}
        enabled={anyOutputReady}
        onToggle={playback.toggle}
        onSeek={playback.seek}
        mixSources={mixSources}
      />
    </div>
  );
}

export function GraphEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphEditorInner {...props} />
    </ReactFlowProvider>
  );
}
