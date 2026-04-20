export interface MixSource {
  url: string;
  volume: number;  // 0 or 1, driven by M/S state
}

export async function renderAndDownloadMix(
  sources: MixSource[],
  filename: string,
): Promise<void> {
  const active = sources.filter((s) => s.volume > 0);
  if (active.length === 0) {
    throw new Error('nothing to mix — every track is muted or un-soloed');
  }

  const ac = new AudioContext();
  const buffers = await Promise.all(
    active.map(async (s) => {
      const resp = await fetch(s.url);
      const arr = await resp.arrayBuffer();
      return ac.decodeAudioData(arr);
    }),
  );
  await ac.close();

  const sampleRate = buffers[0].sampleRate;
  const numChannels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const length = Math.max(...buffers.map((b) => b.length));

  const offline = new OfflineAudioContext(numChannels, length, sampleRate);
  active.forEach((s, i) => {
    const src = offline.createBufferSource();
    src.buffer = buffers[i];
    const gain = offline.createGain();
    gain.gain.value = s.volume;
    src.connect(gain).connect(offline.destination);
    src.start(0);
  });

  const rendered = await offline.startRendering();
  const blob = audioBufferToWav(rendered);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const length = buffer.length;
  const dataSize = length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
