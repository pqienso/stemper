import { useCallback, useRef, type MutableRefObject } from 'react';
import type { Edge, Node } from '@xyflow/react';

// A single point-in-time graph state. Nodes/edges are stored by reference —
// React state updates never mutate arrays in place, so the snapshot is
// effectively immutable without any cloning.
interface Snapshot {
  nodes: Node[];
  edges: Edge[];
  zoneX: number;
}

interface DebounceTag {
  tag: string;
  time: number;
}

interface UseGraphHistoryParams {
  nodes: Node[];
  edges: Edge[];
  zoneX: number;
  setNodes: (updater: Node[] | ((prev: Node[]) => Node[])) => void;
  setEdges: (updater: Edge[] | ((prev: Edge[]) => Edge[])) => void;
  setZoneX: (z: number) => void;
  // Flag flipped to true across a restore so the edge-validity and output
  // derivation effects early-return without clobbering the restored state.
  suppressRef: MutableRefObject<boolean>;
}

const CAP = 50;
const DEBOUNCE_MS = 400;

// Runtime fields in node.data that are re-derived by other effects. We
// deliberately layer these from the CURRENT state over the snapshot's
// structural data on restore, so an undo doesn't resurrect a stale
// "running" fill or drop a live onToggleMute closure.
const RUNTIME_KEYS = [
  'status', 'progress',
  'hasResult', 'muted', 'soloed', 'onToggleMute', 'onToggleSolo',
  'title', 'thumbnail', 'sourceStatus', 'sourceProgress',
];

function mergeRuntime(snapNodes: Node[], currentNodes: Node[]): Node[] {
  const byId = new Map(currentNodes.map((n) => [n.id, n]));
  return snapNodes.map((s) => {
    const cur = byId.get(s.id);
    if (!cur) return s;
    const patch: Record<string, unknown> = {};
    const curData = cur.data as Record<string, unknown>;
    for (const k of RUNTIME_KEYS) {
      if (k in curData) patch[k] = curData[k];
    }
    return { ...s, data: { ...(s.data as Record<string, unknown>), ...patch } };
  });
}

export function useGraphHistory({
  nodes, edges, zoneX, setNodes, setEdges, setZoneX, suppressRef,
}: UseGraphHistoryParams) {
  const pastRef = useRef<Snapshot[]>([]);
  const futureRef = useRef<Snapshot[]>([]);
  const lastTagRef = useRef<DebounceTag | null>(null);

  // Keep refs to current state so callbacks stay stable across renders.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const zoneXRef = useRef(zoneX);
  zoneXRef.current = zoneX;

  const capture = (): Snapshot => ({
    nodes: nodesRef.current,
    edges: edgesRef.current,
    zoneX: zoneXRef.current,
  });

  const pushInternal = (snap: Snapshot) => {
    pastRef.current.push(snap);
    if (pastRef.current.length > CAP) pastRef.current.shift();
    futureRef.current = [];
  };

  const pushSnapshot = useCallback(() => {
    pushInternal(capture());
    lastTagRef.current = null;
  }, []);

  // Skip the push if the last push had the same tag within DEBOUNCE_MS.
  // Used for Inspector text-burst edits so typing "0.75" across 4 keystrokes
  // creates one undo entry, not four.
  const pushDebounced = useCallback((tag: string) => {
    const now = performance.now();
    const last = lastTagRef.current;
    if (last && last.tag === tag && now - last.time < DEBOUNCE_MS) {
      last.time = now;
      return;
    }
    pushInternal(capture());
    lastTagRef.current = { tag, time: now };
  }, []);

  const apply = (snap: Snapshot) => {
    suppressRef.current = true;
    setZoneX(snap.zoneX);
    setNodes((current) => mergeRuntime(snap.nodes, current));
    setEdges(snap.edges);
    // rAF fires after React's next render + effect pass, so every guarded
    // effect observes the flag exactly once before we clear it.
    requestAnimationFrame(() => {
      suppressRef.current = false;
    });
  };

  const undo = useCallback(() => {
    const past = pastRef.current;
    if (past.length === 0) return;
    const snap = past.pop()!;
    futureRef.current.push(capture());
    if (futureRef.current.length > CAP) futureRef.current.shift();
    lastTagRef.current = null;
    apply(snap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodes, setEdges, setZoneX]);

  const redo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0) return;
    const snap = future.pop()!;
    pastRef.current.push(capture());
    if (pastRef.current.length > CAP) pastRef.current.shift();
    lastTagRef.current = null;
    apply(snap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodes, setEdges, setZoneX]);

  const clear = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    lastTagRef.current = null;
  }, []);

  return { pushSnapshot, pushDebounced, undo, redo, clear };
}
