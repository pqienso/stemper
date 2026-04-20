import { memo, useEffect } from 'react';
import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { STEM_COLORS, stemsForModel } from '../types';
import { NodeShell, type HandleDef } from './NodeShell';

export const SplitNode = memo(function SplitNode({ id, data }: NodeProps) {
  const d = data as any;
  const stems = stemsForModel(d.model);
  const updateNodeInternals = useUpdateNodeInternals();

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, stems.length, updateNodeInternals]);

  const handles: HandleDef[] = [
    { id: 'in', side: 'left', color: '#a89984' },
    ...stems.map<HandleDef>((stem) => ({
      id: stem,
      side: 'right',
      color: STEM_COLORS[stem] ?? '#a89984',
      label: stem,
    })),
  ];
  return (
    <NodeShell
      color="#83a598"
      status={d.status}
      progress={d.progress}
      symbol={
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="4" cy="12" r="1.6" />
          <circle cx="20" cy="4" r="1.6" />
          <circle cx="20" cy="12" r="1.6" />
          <circle cx="20" cy="20" r="1.6" />
          <path d="M5.5 12 L18.5 4 M5.5 12 H18.5 M5.5 12 L18.5 20" fill="none" />
        </svg>
      }
      handles={handles}
      handleYNudge={11}
    />
  );
});
