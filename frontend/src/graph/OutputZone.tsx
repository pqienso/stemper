import { ViewportPortal } from '@xyflow/react';

interface Props {
  zoneX: number;
  rowStep: number;
}

// World-space slab marking the Output-only area. Grid lines are drawn in SVG
// with non-scaling-stroke so they stay crisp at any zoom level (unlike a CSS
// linear-gradient inside the viewport transform, which sub-pixels out).
export function OutputZone({ zoneX, rowStep }: Props) {
  const half = Math.ceil(10000 / rowStep) * rowStep;
  const height = 2 * half;
  const width = 20000;

  const lines: number[] = [];
  for (let y = 0; y <= height; y += rowStep) lines.push(y);

  return (
    <ViewportPortal>
      <svg
        width={width}
        height={height}
        className="pointer-events-none"
        style={{
          position: 'absolute',
          transform: `translate(${zoneX}px, ${-half}px)`,
          overflow: 'visible',
        }}
      >
        <rect x={0} y={0} width={width} height={height} fill="rgba(235, 219, 178, 0.04)" />
        <line
          x1={0} y1={0} x2={0} y2={height}
          stroke="#504945"
          strokeDasharray="6 4"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {lines.map((y) => (
          <line
            key={y}
            x1={0} y1={y} x2={width} y2={y}
            stroke="rgba(235, 219, 178, 0.18)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </ViewportPortal>
  );
}
