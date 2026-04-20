import { memo, useEffect } from 'react';
import {
  useNodeConnections,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { NodeShell, type HandleDef } from './NodeShell';

export const MixNode = memo(function MixNode({ id, data }: NodeProps) {
  const d = data as any;
  const connections = useNodeConnections({ id, handleType: 'target' });
  const updateNodeInternals = useUpdateNodeInternals();

  const numSlots = Math.max(connections.length + 1, 3);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, numSlots, updateNodeInternals]);

  const connectedSet = new Set(connections.map((c) => c.targetHandle));

  const handles: HandleDef[] = [
    ...Array.from({ length: numSlots }, (_, i): HandleDef => {
      const hid = `in_${i}`;
      const connected = connectedSet.has(hid);
      return {
        id: hid,
        side: 'left',
        color: connected ? '#a89984' : '#3c3836',
      };
    }),
    { id: 'out', side: 'right', color: '#d3869b' },
  ];

  return (
    <NodeShell
      color="#d3869b"
      status={d.status}
      progress={d.progress}
      symbol={
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="4" cy="4" r="1.6" />
          <circle cx="4" cy="12" r="1.6" />
          <circle cx="4" cy="20" r="1.6" />
          <circle cx="20" cy="12" r="1.6" />
          <path d="M5.5 4 L18.5 12 M5.5 12 H18.5 M5.5 20 L18.5 12" fill="none" />
        </svg>
      }
      handles={handles}
    />
  );
});
