import { useEffect, useMemo, useRef, useState } from 'react';

const PALETTES = [
  'green',
  'blue',
  'pink',
  'red',
  'yellow',
  'aqua',
  'orange',
  'purple',
] as const;
type Palette = (typeof PALETTES)[number];

const CLICKS_PER_PALETTE = 10;

const FRAME_MS = 250;
const BLINK_HOLD_MS = 150;
const MOUTH_HOLD_MS = 300;
const SPECIAL_MIN_MS = 5000;
const SPECIAL_MAX_MS = 10000;
const HOP_MIN_MS = 3000;
const HOP_MAX_MS = 6000;
const HOP_DURATION_MS = 450;

type Overlay = 'blink' | 'mouth' | null;
type Props = { size?: number; dancing?: boolean; className?: string };

function svgPath(palette: Palette, name: string): string {
  if (palette === 'green') {
    return name === 'neutral' ? '/favicon-full.svg' : `/stem-mon/${name}`;
  }
  const file = name === 'neutral' ? 'neutral.svg' : name;
  return `/stem-mon/${palette}/${file}`;
}

function randDelay() {
  return SPECIAL_MIN_MS + Math.random() * (SPECIAL_MAX_MS - SPECIAL_MIN_MS);
}

export function StemmonDancer({ size = 16, dancing = false, className = '' }: Props) {
  const [danceIdx, setDanceIdx] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [hopCount, setHopCount] = useState(0);
  const [clicks, setClicks] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);

  const palette = PALETTES[Math.floor(clicks / CLICKS_PER_PALETTE) % PALETTES.length];

  const danceCycle = useMemo(
    () => [
      svgPath(palette, 'dance-1.svg'),
      svgPath(palette, 'neutral'),
      svgPath(palette, 'dance-2.svg'),
      svgPath(palette, 'neutral'),
      svgPath(palette, 'dance-3.svg'),
      svgPath(palette, 'neutral'),
      svgPath(palette, 'dance-4.svg'),
      svgPath(palette, 'neutral'),
    ],
    [palette],
  );
  const neutralFrame = svgPath(palette, 'neutral');
  const blinkFrame = svgPath(palette, 'frame-blink.svg');
  const mouthFrame = svgPath(palette, 'frame-mouth-closed.svg');

  useEffect(() => {
    if (!dancing) return;
    const id = window.setInterval(() => {
      setDanceIdx((i) => (i + 1) % danceCycle.length);
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [dancing, danceCycle.length]);

  useEffect(() => {
    const schedule = (kind: 'blink' | 'mouth', holdMs: number) => {
      let startId: number;
      let endId: number;
      const run = () => {
        startId = window.setTimeout(() => {
          setOverlay(kind);
          endId = window.setTimeout(() => {
            setOverlay((cur) => (cur === kind ? null : cur));
            run();
          }, holdMs);
        }, randDelay());
      };
      run();
      return () => {
        window.clearTimeout(startId);
        window.clearTimeout(endId);
      };
    };
    const cleanupBlink = schedule('blink', BLINK_HOLD_MS);
    const cleanupMouth = schedule('mouth', MOUTH_HOLD_MS);
    return () => {
      cleanupBlink();
      cleanupMouth();
    };
  }, []);

  useEffect(() => {
    if (!dancing) return;
    let id: number;
    const schedule = () => {
      id = window.setTimeout(() => {
        setHopCount((c) => c + 1);
        schedule();
      }, HOP_MIN_MS + Math.random() * (HOP_MAX_MS - HOP_MIN_MS));
    };
    schedule();
    return () => window.clearTimeout(id);
  }, [dancing]);

  useEffect(() => {
    if (hopCount === 0) return;
    const el = imgRef.current;
    if (!el) return;
    const hopHeight = Math.max(12, Math.round(size * 0.1));
    const anim = el.animate(
      [
        { transform: 'translateY(0)' },
        { transform: `translateY(-${hopHeight}px)`, offset: 0.4 },
        { transform: 'translateY(0)', offset: 0.75 },
        { transform: `translateY(-${Math.round(hopHeight * 0.25)}px)`, offset: 0.88 },
        { transform: 'translateY(0)' },
      ],
      { duration: HOP_DURATION_MS, easing: 'ease-out' },
    );
    return () => anim.cancel();
  }, [hopCount, size]);

  const src =
    overlay === 'blink'
      ? blinkFrame
      : overlay === 'mouth'
        ? mouthFrame
        : dancing
          ? danceCycle[danceIdx]
          : neutralFrame;

  return (
    <img
      ref={imgRef}
      src={src}
      width={size}
      height={size}
      alt=""
      className={className}
      onClick={() => {
        setClicks((c) => c + 1);
        setHopCount((c) => c + 1);
      }}
      style={{ imageRendering: 'pixelated', cursor: 'pointer' }}
    />
  );
}
