import { memo, useEffect } from 'react';
import {
  Handle,
  Position,
  useNodeConnections,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { parseSlotHandle } from '../types';
import { NodeFillOverlay, RunningBorder, nodeFillState } from './nodeChrome';

// Aqua — distinct from source/split/mix/output.
const COLOR = '#8ec07c';

const ROW_H = 30;
const BODY_PAD = 10;
const HANDLE_SIZE = 20;
const HANDLE_OFFSET = HANDLE_SIZE / 2;
const WIDTH = 90;

export const PitchSpeedNode = memo(function PitchSpeedNode({ id, data }: NodeProps) {
  const d = data as any;
  const status: string | undefined = d.status;
  const progress: number | undefined = d.progress;
  const pitch: number = typeof d.pitch_semitones === 'number' ? d.pitch_semitones : 0;
  const tempo: number = typeof d.tempo_ratio === 'number' ? d.tempo_ratio : 1;
  const identity = pitch === 0 && tempo === 1;

  // Live connection state drives row count. Each connected slot is a paired
  // (in_{sid}, out_{sid}) row; one extra empty row provides a drop target
  // for a new input, carrying the next unused slot_id.
  const connections = useNodeConnections({ id, handleType: 'target' });
  const updateNodeInternals = useUpdateNodeInternals();

  const slotIds: number[] = [];
  for (const c of connections) {
    const sid = parseSlotHandle(c.targetHandle);
    if (sid !== null) slotIds.push(sid);
  }
  const uniqSlots = Array.from(new Set(slotIds)).sort((a, b) => a - b);
  const nextSlotId = uniqSlots.length ? Math.max(...uniqSlots) + 1 : 0;

  const rowCount = uniqSlots.length + 1;

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, rowCount, updateNodeInternals]);

  const bodyH = rowCount * ROW_H + BODY_PAD * 2;
  const height = bodyH;
  const rowCenterY = (i: number): number => BODY_PAD + i * ROW_H + ROW_H / 2;

  const { fillPct, fillColor, baseBorder, running } = nodeFillState(status, progress, COLOR);

  // Dim the symbol when identity (pitch=0, tempo=1) — it's a pure passthrough.
  const symbolOpacity = identity ? 0.35 : 1;

  return (
    <div
      className="relative"
      style={{ width: WIDTH, height }}
      title={identity ? 'passthrough (pitch 0, tempo 1×)' : `pitch ${pitch >= 0 ? '+' : ''}${pitch}st · tempo ${tempo.toFixed(2)}×`}
    >
      <div
        className="absolute inset-0 rounded-md shadow-md overflow-hidden"
        style={{ background: '#282828', border: `2px solid ${baseBorder}` }}
      >
        <NodeFillOverlay fillPct={fillPct} fillColor={fillColor} />

        {/* Single centered symbol — clock + up/down arrows. */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ color: COLOR, opacity: symbolOpacity }}
        >
          <div style={{ transform: 'scale(2.2)', transformOrigin: 'center' }}>
            <ClockArrowsIcon />
          </div>
        </div>
      </div>

      {running && <RunningBorder color={COLOR} />}

      {uniqSlots.map((sid, i) => (
        <RowHandles key={sid} y={rowCenterY(i)} slotId={sid} active />
      ))}
      <Handle
        type="target"
        position={Position.Left}
        id={`in_${nextSlotId}`}
        title="connect an input"
        style={{
          top: rowCenterY(uniqSlots.length) - HANDLE_OFFSET,
          left: -HANDLE_OFFSET,
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          background: '#3c3836',
          border: '2px solid #1d2021',
          borderRadius: '50%',
          zIndex: 10,
        }}
      />
    </div>
  );
});

function RowHandles({ y, slotId, active }: { y: number; slotId: number; active: boolean }) {
  const color = active ? COLOR : '#3c3836';
  const style = (side: 'left' | 'right'): React.CSSProperties => ({
    top: y - HANDLE_OFFSET,
    [side]: -HANDLE_OFFSET,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: color,
    border: '2px solid #1d2021',
    borderRadius: '50%',
    zIndex: 10,
  });
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        id={`in_${slotId}`}
        title={`in ${slotId}`}
        style={style('left')}
      />
      <Handle
        type="source"
        position={Position.Right}
        id={`out_${slotId}`}
        title={`out ${slotId}`}
        style={style('right')}
      />
    </>
  );
}

function ClockArrowsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Clock face + hands */}
      <circle cx="9" cy="12" r="6" />
      <path d="M9 12 V9" />
      <path d="M9 12 H12" />
      {/* Up/down double arrow */}
      <path d="M19 7 V17" />
      <path d="M17 9 L19 7 L21 9" />
      <path d="M17 15 L19 17 L21 15" />
    </svg>
  );
}
