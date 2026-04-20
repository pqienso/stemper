import { Handle, Position, type HandleType } from '@xyflow/react';
import type { ReactNode } from 'react';
import { NodeFillOverlay, RunningBorder, nodeFillState } from './nodeChrome';

export interface HandleDef {
  id: string;
  side: 'left' | 'right';
  color: string;
  label?: string;  // inline text beside the handle (stem names for Split)
  title?: string;  // hover tooltip
}

interface Props {
  color: string;
  status?: string;
  symbol: ReactNode;
  handles: HandleDef[];
  width?: number;
  progress?: number;  // 0..1 — bottom-up fill while running
  handleYNudge?: number;  // downward pixel offset applied to handle circles
}

const HEADER_H = 26;
const ROW_H = 30;
const BODY_PAD = 10;
const HANDLE_SIZE = 20;
const HANDLE_OFFSET = HANDLE_SIZE / 2;

export function NodeShell({
  color,
  status,
  symbol,
  handles,
  width = 90,
  progress,
  handleYNudge = 0,
}: Props) {
  const left = handles.filter((h) => h.side === 'left');
  const right = handles.filter((h) => h.side === 'right');
  const rows = Math.max(left.length, right.length, 1);

  const bodyH = rows * ROW_H + BODY_PAD * 2;
  const height = HEADER_H + bodyH;

  const { fillPct, fillColor, baseBorder, running } = nodeFillState(status, progress, color);

  const bodyStart = HEADER_H + BODY_PAD;
  const rowY = (i: number, total: number): number => {
    const usedH = total * ROW_H;
    const startOffset = (rows * ROW_H - usedH) / 2;
    return bodyStart + startOffset + i * ROW_H + ROW_H / 2;
  };

  const hasLabels = handles.some((h) => h.label);

  return (
    <div className="relative" style={{ width, height }}>
      <div
        className="absolute inset-0 rounded-md shadow-md overflow-hidden"
        style={{ background: '#282828', border: `2px solid ${baseBorder}` }}
      >
        <NodeFillOverlay fillPct={fillPct} fillColor={fillColor} />
        {hasLabels ? (
          <>
            {/* Header: small symbol */}
            <div
              className="flex items-center justify-center"
              style={{ height: HEADER_H, color, borderBottom: '1px solid #3c3836' }}
            >
              {symbol}
            </div>

            {/* Handle label rows */}
            {left.map((h, i) => {
              if (!h.label) return null;
              const y = rowY(i, left.length) - ROW_H / 2;
              return (
                <div
                  key={`ll-${h.id}`}
                  className="absolute text-[9px] text-gruvbox-fg3 truncate pointer-events-none"
                  style={{
                    top: y,
                    left: 8,
                    right: '50%',
                    height: ROW_H,
                    lineHeight: `${ROW_H}px`,
                  }}
                >
                  {h.label}
                </div>
              );
            })}
            {right.map((h, i) => {
              if (!h.label) return null;
              const y = rowY(i, right.length) - ROW_H / 2;
              return (
                <div
                  key={`rl-${h.id}`}
                  className="absolute text-[9px] text-gruvbox-fg3 truncate text-right pointer-events-none"
                  style={{
                    top: y,
                    right: 8,
                    left: '50%',
                    height: ROW_H,
                    lineHeight: `${ROW_H}px`,
                  }}
                >
                  {h.label}
                </div>
              );
            })}
          </>
        ) : (
          /* No labels: one big centered symbol, no header strip */
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ color }}
          >
            <div style={{ transform: 'scale(2.2)', transformOrigin: 'center' }}>
              {symbol}
            </div>
          </div>
        )}
      </div>

      {running && <RunningBorder color={color} />}

      {left.map((h, i) => renderHandle(h, rowY(i, left.length), 'target', 'left', handleYNudge))}
      {right.map((h, i) => renderHandle(h, rowY(i, right.length), 'source', 'right', handleYNudge))}
    </div>
  );
}

function renderHandle(h: HandleDef, y: number, type: HandleType, side: 'left' | 'right', yNudge: number) {
  const base: React.CSSProperties = {
    top: y - HANDLE_OFFSET + yNudge,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: h.color,
    border: '2px solid #1d2021',
    borderRadius: '50%',
    zIndex: 10,
  };
  const sideStyle: React.CSSProperties =
    side === 'left' ? { left: -HANDLE_OFFSET } : { right: -HANDLE_OFFSET };
  return (
    <Handle
      key={`h-${side}-${h.id}`}
      type={type}
      position={side === 'left' ? Position.Left : Position.Right}
      id={h.id}
      title={h.title ?? h.label}
      style={{ ...base, ...sideStyle }}
    />
  );
}
