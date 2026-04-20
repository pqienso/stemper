import { memo } from 'react';
import { type NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { NodeFillOverlay, RunningBorder, nodeFillState } from './nodeChrome';

const COLOR = '#b8bb26';
const MUTE_COLOR = '#fb4934';
const SOLO_COLOR = '#fabd2f';

export const OutputNode = memo(function OutputNode({ data }: NodeProps) {
  const d = data as any;
  const label: string = d.label ?? '';
  const muted: boolean = !!d.muted;
  const soloed: boolean = !!d.soloed;
  const hasResult: boolean = !!d.hasResult;
  const onToggleMute: (() => void) | undefined = d.onToggleMute;
  const onToggleSolo: (() => void) | undefined = d.onToggleSolo;
  const status: string | undefined = d.status;
  const progress: number | undefined = d.progress;

  const { fillPct, fillColor, baseBorder, running } = nodeFillState(status, progress, COLOR);

  const width = 90;
  const height = 90;

  return (
    <div className="relative cursor-move" style={{ width, height }}>
      <div
        className="absolute inset-0 rounded-md shadow-md overflow-hidden flex flex-col"
        style={{ background: '#282828', border: `2px solid ${baseBorder}` }}
      >
        <NodeFillOverlay fillPct={fillPct} fillColor={fillColor} />

        <div
          className="flex items-center justify-center px-1 pointer-events-none"
          style={{
            height: 22,
            color: COLOR,
            background: '#1d2021',
            borderBottom: '1px solid #3c3836',
          }}
          title={label}
        >
          <span className="text-[11px] font-semibold truncate leading-none">
            {label || 'output'}
          </span>
        </div>

        {/* Center: non-interactive speaker icon. Its parent is draggable. */}
        <div
          className="flex-1 flex items-center justify-center pointer-events-none"
          style={{ color: COLOR }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3z" />
            <path
              d="M14 8.5c1.5 1.5 1.5 5.5 0 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path
              d="M17 5.5c3 3 3 10 0 13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <div className="flex border-t border-gruvbox-bg2" style={{ height: 22 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleMute?.(); }}
            disabled={!hasResult}
            className="flex-1 text-[10px] font-bold nodrag border-r border-gruvbox-bg2
                       disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              color: muted ? MUTE_COLOR : '#a89984',
              background: muted ? 'rgba(251,73,52,0.15)' : 'transparent',
            }}
            title={muted ? 'un-mute' : 'mute'}
          >
            M
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSolo?.(); }}
            disabled={!hasResult}
            className="flex-1 text-[10px] font-bold nodrag
                       disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              color: soloed ? SOLO_COLOR : '#a89984',
              background: soloed ? 'rgba(250,189,47,0.15)' : 'transparent',
            }}
            title={soloed ? 'un-solo' : 'solo'}
          >
            S
          </button>
        </div>
      </div>

      {running && <RunningBorder color={COLOR} />}

      <Handle
        type="target"
        position={Position.Left}
        id="in"
        style={{
          top: height / 2 - 10,
          left: -10,
          width: 20,
          height: 20,
          background: COLOR,
          border: '2px solid #1d2021',
          borderRadius: '50%',
          zIndex: 10,
        }}
      />
    </div>
  );
});
