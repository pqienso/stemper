import { useEffect, useRef, useState } from 'react';
import { renderAndDownloadMix, type MixSource } from './mixDownload';

interface Props {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  enabled: boolean;
  onToggle: () => void;
  onSeek: (t: number) => void;
  mixSources: MixSource[];
}

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Accepts "m:ss", "m:ss.fff", or a plain-seconds number. Returns NaN on parse failure.
function parseTime(raw: string): number {
  const s = raw.trim();
  if (!s) return NaN;
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length !== 2) return NaN;
    const m = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(sec)) return NaN;
    return m * 60 + sec;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function Scrubber({
  currentTime,
  duration,
  enabled,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  enabled: boolean;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // Throttle drag-seeks: HTMLMediaElement can't process 60+ seeks/sec and
  // playback stalls into stutter. 50ms still feels instant to the user.
  const SCRUB_THROTTLE_MS = 50;
  const lastScrubMsRef = useRef(0);
  const lastClientXRef = useRef(0);
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  const seekFromClientX = (clientX: number) => {
    const el = ref.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    e.preventDefault();
    draggingRef.current = true;
    lastScrubMsRef.current = performance.now();
    lastClientXRef.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    lastClientXRef.current = e.clientX;
    const now = performance.now();
    if (now - lastScrubMsRef.current < SCRUB_THROTTLE_MS) return;
    lastScrubMsRef.current = now;
    seekFromClientX(e.clientX);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    // Final seek to the exact release position, so the throttle doesn't
    // leave playback a few pixels short of where the user dropped.
    seekFromClientX(lastClientXRef.current);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={`flex-1 relative h-6 flex items-center ${
        enabled ? 'cursor-pointer' : 'cursor-not-allowed'
      }`}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={duration || 0}
      aria-valuenow={currentTime}
      aria-disabled={!enabled}
    >
      <div className="absolute inset-x-0 h-1 bg-gruvbox-bg2 rounded pointer-events-none" />
      <div
        className="absolute left-0 h-1 bg-gruvbox-orange rounded pointer-events-none"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute w-3 h-3 -ml-1.5 rounded-full bg-gruvbox-orange shadow pointer-events-none"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}

export function TransportBar({
  isPlaying, currentTime, duration, enabled,
  onToggle, onSeek, mixSources,
}: Props) {
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    if (!enabled || duration <= 0) return;
    setDraft(fmt(currentTime));
    setEditing(true);
  };

  const commitEdit = () => {
    const t = parseTime(draft);
    if (Number.isFinite(t)) {
      const clamped = Math.max(0, Math.min(duration, t));
      onSeek(clamped);
    }
    setEditing(false);
  };

  const downloadMix = async () => {
    setErr(null);
    setDownloading(true);
    try {
      await renderAndDownloadMix(mixSources, 'mix.wav');
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="border-t border-gruvbox-bg2 bg-gruvbox-bg px-4 py-2 flex items-center gap-3">
      <button
        onClick={onToggle}
        disabled={!enabled}
        className="w-10 h-10 rounded-full flex items-center justify-center
                   bg-gruvbox-orange text-gruvbox-bg-h shrink-0
                   hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed"
        title={isPlaying ? 'pause' : 'play'}
      >
        {isPlaying ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 5 L19 12 L7 19 Z" />
          </svg>
        )}
      </button>

      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            else if (e.key === 'Escape') setEditing(false);
          }}
          placeholder="m:ss"
          className="text-[11px] tabular-nums shrink-0 w-16 text-right
                     bg-gruvbox-bg1 text-gruvbox-fg px-1 py-0.5 rounded
                     border border-gruvbox-orange outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          disabled={!enabled || duration <= 0}
          title="click to enter an exact time (m:ss)"
          className="text-[11px] text-gruvbox-fg3 tabular-nums shrink-0 w-16 text-right
                     px-1 py-0.5 rounded hover:bg-gruvbox-bg1 hover:text-gruvbox-fg
                     disabled:cursor-not-allowed"
        >
          {fmt(currentTime)}
        </button>
      )}

      <Scrubber
        currentTime={currentTime}
        duration={duration}
        enabled={enabled && duration > 0}
        onSeek={onSeek}
      />

      <span className="text-[11px] text-gruvbox-fg3 tabular-nums shrink-0 w-16">
        {fmt(duration)}
      </span>

      {err && (
        <span className="text-[10px] text-gruvbox-red shrink-0" title={err}>
          {err.slice(0, 40)}
        </span>
      )}

      <button
        onClick={downloadMix}
        disabled={!enabled || downloading}
        className="px-3 py-1.5 text-[11px] font-semibold rounded shrink-0
                   bg-gruvbox-bg1 text-gruvbox-fg3 border border-gruvbox-bg3
                   hover:bg-gruvbox-bg2 hover:text-gruvbox-fg
                   disabled:opacity-30 disabled:cursor-not-allowed"
        title="download the mix (M/S applied)"
      >
        {downloading ? '…mixing' : '↓ download mix'}
      </button>
    </div>
  );
}
