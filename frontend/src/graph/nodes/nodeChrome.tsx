const ERROR_COLOR = '#fb4934';

export interface NodeFillState {
  fillPct: number;
  fillColor: string;
  baseBorder: string;
  running: boolean;
}

// Fill rules: done/cached/error hold at 100% (error uses red), running shows
// live progress, everything else drains to 0. The running state also dims the
// static border so the flicker overlay drives the visible animation.
export function nodeFillState(
  status: string | undefined,
  progress: number | undefined,
  color: string,
): NodeFillState {
  const fillPct =
    status === 'done' || status === 'cached' || status === 'error'
      ? 100
      : status === 'running' && typeof progress === 'number'
      ? Math.max(0, Math.min(1, progress)) * 100
      : 0;
  const running = status === 'running';
  return {
    fillPct,
    fillColor: status === 'error' ? ERROR_COLOR : color,
    baseBorder: running ? `${color}55` : color,
    running,
  };
}

export function NodeFillOverlay({ fillPct, fillColor }: { fillPct: number; fillColor: string }) {
  return (
    <div
      className="absolute left-0 right-0 bottom-0 pointer-events-none"
      style={{
        height: `${fillPct}%`,
        backgroundColor: `${fillColor}26`,
        transition: 'height 400ms linear, background-color 250ms linear',
      }}
    />
  );
}

export function RunningBorder({ color }: { color: string }) {
  return (
    <div
      className="absolute inset-0 rounded-md pointer-events-none animate-node-border-flicker"
      style={{ border: `2px solid ${color}` }}
    />
  );
}
