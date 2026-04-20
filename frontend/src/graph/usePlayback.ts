import { useCallback, useEffect, useRef, useState } from 'react';

export interface TrackConfig {
  nodeId: string;
  url: string;
}

export interface MultiPlayback {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  mutes: Set<string>;
  solos: Set<string>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  setTracks: (tracks: TrackConfig[]) => void;
  toggleMute: (nodeId: string) => void;
  toggleSolo: (nodeId: string) => void;
}

// Volume model: if any track is soloed, only soloed tracks play. A muted
// track is always silent. Otherwise, every track plays at full volume.
export function computeVolume(nodeId: string, mutes: Set<string>, solos: Set<string>): number {
  if (mutes.has(nodeId)) return 0;
  if (solos.size > 0 && !solos.has(nodeId)) return 0;
  return 1;
}

// Sync thresholds. Hard-seeking every frame creates a feedback loop: seeking
// briefly pauses decode, which causes more drift, which triggers another
// seek, and playback stutters. So we use three tiers:
//
//   < DRIFT_NUDGE_THRESHOLD : in-tolerance, playbackRate = 1.
//   < DRIFT_SEEK_THRESHOLD  : small drift, nudge with playbackRate ±3%.
//   otherwise               : gross drift (e.g. user seeked, network hiccup),
//                             hard seek once.
//
// Sync is also throttled to SYNC_INTERVAL_MS rather than running every frame.
const DRIFT_NUDGE_THRESHOLD = 0.04;   // 40ms — inside this, leave alone
const DRIFT_SEEK_THRESHOLD = 0.5;     // 500ms — past this, hard seek
const NUDGE_RATE = 0.03;              // ±3% playbackRate
const SYNC_INTERVAL_MS = 400;

// Slack for "is this track past its own end?" — browsers settle `currentTime`
// a few ms shy of `duration` at the end.
const END_EPS = 0.02;

export function useMultiPlayback(): MultiPlayback {
  const audiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const durationsRef = useRef<Map<string, number>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastSyncMsRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [mutes, setMutes] = useState<Set<string>>(new Set());
  const [solos, setSolos] = useState<Set<string>>(new Set());
  const mutesRef = useRef<Set<string>>(mutes);
  mutesRef.current = mutes;
  const solosRef = useRef<Set<string>>(solos);
  solosRef.current = solos;

  useEffect(() => {
    for (const [nodeId, el] of audiosRef.current.entries()) {
      el.volume = computeVolume(nodeId, mutes, solos);
    }
  }, [mutes, solos]);

  const maxDuration = (): number => {
    let d = 0;
    for (const v of durationsRef.current.values()) {
      if (Number.isFinite(v) && v > d) d = v;
    }
    return d;
  };

  // Anchor = the track with the largest known duration. Its playhead is the
  // canonical time everyone else is snapped to (when they're still playing).
  const anchorEl = (): HTMLAudioElement | null => {
    let best: HTMLAudioElement | null = null;
    let bestDur = -1;
    for (const [id, el] of audiosRef.current.entries()) {
      const d = durationsRef.current.get(id) ?? 0;
      if (d > bestDur) {
        bestDur = d;
        best = el;
      }
    }
    if (best) return best;
    const first = audiosRef.current.values().next().value as HTMLAudioElement | undefined;
    return first ?? null;
  };

  const stopRaf = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const tick = () => {
    const anchor = anchorEl();
    if (!anchor) {
      rafRef.current = null;
      return;
    }
    const anchorT = anchor.currentTime;

    // UI update runs every frame for smooth scrubber motion.
    setCurrentTime(anchorT);

    // Sync check runs on a throttle, not every frame. Hard-seeking at 60Hz
    // is what caused the stutter feedback loop.
    const now = performance.now();
    if (now - lastSyncMsRef.current >= SYNC_INTERVAL_MS) {
      lastSyncMsRef.current = now;
      for (const [id, el] of audiosRef.current.entries()) {
        if (el === anchor) continue;
        const d = durationsRef.current.get(id) ?? Infinity;
        if (el.ended || el.currentTime >= d - END_EPS) continue;
        // Don't compound: if the browser is still satisfying a prior seek,
        // let it land before touching currentTime or playbackRate again.
        if (el.seeking) continue;

        const drift = el.currentTime - anchorT;
        const absDrift = Math.abs(drift);

        if (absDrift < DRIFT_NUDGE_THRESHOLD) {
          // In tolerance. Clear any lingering nudge.
          if (el.playbackRate !== 1) el.playbackRate = 1;
        } else if (absDrift < DRIFT_SEEK_THRESHOLD) {
          // Small drift — nudge playbackRate. Slow down if ahead of anchor,
          // speed up if behind. The next sync tick resets it.
          const targetRate = drift > 0 ? 1 - NUDGE_RATE : 1 + NUDGE_RATE;
          if (Math.abs(el.playbackRate - targetRate) > 1e-6) {
            el.playbackRate = targetRate;
          }
        } else {
          // Too far out — hard seek. User seek, network hiccup, tab backgrounded.
          try {
            el.playbackRate = 1;
            el.currentTime = Math.min(anchorT, Math.max(0, d - END_EPS));
          } catch {
            // Seeking can throw if the element isn't ready yet; ignore.
          }
        }
      }
    }

    // End condition: every track is past its own end. Shorter tracks finish
    // silently and sit at their end until the longest one also finishes.
    let allEnded = true;
    for (const [id, el] of audiosRef.current.entries()) {
      const d = durationsRef.current.get(id) ?? Infinity;
      if (!el.ended && el.currentTime < d - END_EPS) {
        allEnded = false;
        break;
      }
    }
    if (allEnded) {
      for (const el of audiosRef.current.values()) {
        el.pause();
        el.currentTime = 0;
        el.playbackRate = 1;
      }
      setIsPlaying(false);
      setCurrentTime(0);
      rafRef.current = null;
      return;
    }

    rafRef.current = requestAnimationFrame(tick);
  };

  const startRaf = () => {
    stopRaf();
    lastSyncMsRef.current = 0;  // force a sync on the first tick
    rafRef.current = requestAnimationFrame(tick);
  };

  const setTracks = useCallback((tracks: TrackConfig[]) => {
    const current = audiosRef.current;
    const nextIds = new Set(tracks.map((t) => t.nodeId));

    for (const [id, el] of Array.from(current.entries())) {
      if (!nextIds.has(id)) {
        el.pause();
        el.src = '';
        current.delete(id);
        durationsRef.current.delete(id);
      }
    }

    for (const t of tracks) {
      const existing = current.get(t.nodeId);
      if (existing && existing.src.endsWith(t.url)) continue;
      if (existing) existing.pause();
      const el = new Audio(t.url);
      el.preload = 'auto';
      el.volume = computeVolume(t.nodeId, mutes, solos);
      current.set(t.nodeId, el);
      durationsRef.current.delete(t.nodeId);

      const captureDuration = () => {
        if (Number.isFinite(el.duration) && el.duration > 0) {
          durationsRef.current.set(t.nodeId, el.duration);
          setDuration(maxDuration());
        }
      };
      el.addEventListener('loadedmetadata', captureDuration);
      el.addEventListener('durationchange', captureDuration);
      if (Number.isFinite(el.duration) && el.duration > 0) {
        durationsRef.current.set(t.nodeId, el.duration);
      }
    }

    setDuration(maxDuration());
  }, [mutes, solos]);

  const play = useCallback(() => {
    for (const el of audiosRef.current.values()) {
      // Reset any lingering nudge from the previous session so play starts
      // from a clean 1.0× rate on every track.
      el.playbackRate = 1;
      el.play().catch((e) => console.warn('audio play failed', e));
    }
    setIsPlaying(true);
    startRaf();
  }, []);

  const pause = useCallback(() => {
    for (const el of audiosRef.current.values()) {
      el.pause();
    }
    setIsPlaying(false);
    stopRaf();
  }, []);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  // Seek clamps per track to its own duration. Shorter tracks land at their
  // end and stay silent; longer tracks resume from t. Resets playbackRate
  // so an in-flight nudge doesn't carry over the seek.
  const seek = useCallback((t: number) => {
    for (const [id, el] of audiosRef.current.entries()) {
      const d = durationsRef.current.get(id) ?? Infinity;
      const clamped = Math.max(0, Math.min(t, Number.isFinite(d) ? d : t));
      el.playbackRate = 1;
      try {
        el.currentTime = clamped;
      } catch {
        // ignore seeks on not-yet-ready elements
      }
    }
    setCurrentTime(t);
    lastSyncMsRef.current = performance.now();
  }, []);

  const toggleMute = useCallback((nodeId: string) => {
    const turningOn = !mutesRef.current.has(nodeId);
    setMutes((prev) => {
      const next = new Set(prev);
      if (turningOn) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
    if (turningOn && solosRef.current.has(nodeId)) {
      setSolos((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    }
  }, []);

  const toggleSolo = useCallback((nodeId: string) => {
    const turningOn = !solosRef.current.has(nodeId);
    setSolos(() => (turningOn ? new Set([nodeId]) : new Set()));
    if (turningOn && mutesRef.current.has(nodeId)) {
      setMutes((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    return () => {
      stopRaf();
      for (const el of audiosRef.current.values()) {
        el.pause();
        el.src = '';
      }
      audiosRef.current.clear();
      durationsRef.current.clear();
    };
  }, []);

  return {
    isPlaying, currentTime, duration,
    mutes, solos,
    play, pause, toggle, seek,
    setTracks, toggleMute, toggleSolo,
  };
}
