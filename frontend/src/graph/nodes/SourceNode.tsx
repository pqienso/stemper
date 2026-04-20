import { memo } from 'react';
import { type NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';

export const SourceNode = memo(function SourceNode({ data }: NodeProps) {
  const d = data as any;
  // Map source load state to the ring color; fall back to run status otherwise.
  const ringStatus =
    d.sourceStatus === 'downloading'
      ? 'running'
      : d.sourceStatus === 'error'
      ? 'error'
      : d.status;

  // Dim the node when no audio is loaded — hints that it needs attention.
  const empty = d.sourceStatus === 'empty' || !d.sourceStatus;
  const borderColor = empty ? '#7c6f64' : '#fabd2f';

  // Fill rules for Source:
  //   downloading     → live upload/download progress (sourceProgress)
  //   ready (have WAV)→ force 'done' so the bar stays full even after a graph
  //                     change wipes nodeStatus; this is the "special case" —
  //                     the source is still loaded, so the fill reflects that.
  //   otherwise       → fall through to the node's run status
  let shellStatus: string | undefined = ringStatus;
  let progress: number | undefined = d.progress;
  if (d.sourceStatus === 'downloading') {
    shellStatus = 'running';
    progress = d.sourceProgress;
  } else if (d.sourceStatus === 'ready' && d.status !== 'error') {
    shellStatus = 'done';
    progress = 1;
  }

  return (
    <NodeShell
      color={borderColor}
      status={shellStatus}
      progress={progress}
      symbol={
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 17V5l10-2v12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="7" cy="17" r="2.5" />
          <circle cx="17" cy="15" r="2.5" />
        </svg>
      }
      handles={[{ id: 'out', side: 'right', color: borderColor }]}
    />
  );
});
