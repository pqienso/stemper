import { useMemo, useRef, useState } from 'react';
import { useReactFlow, type Node, type Edge } from '@xyflow/react';
import type { DemucsModel } from './types';
import { nodeTypeColor } from './types';
import type { SourceState } from './GraphEditor';
import { StemmonDancer } from './StemmonDancer';

interface Props {
  selectedId: string | null;
  nodes: Node[];
  edges: Edge[];
  jobId: string | null;
  outputs: Record<string, { label: string; hash: string }>;
  outputAudioUrl: (jobId: string, nodeId: string) => string;
  onClose: () => void;
  sourceState: SourceState;
  onSourceFromUrl: (url: string) => Promise<void>;
  onSourceFromFile: (file: File) => Promise<void>;
  onResetSource: () => void;
  onRun: () => void;
  onCancel: () => void;
  runDisabled: boolean;
  runStatus: 'idle' | 'running' | 'done' | 'error';
  presetLoadKey: number;
  // Called before every user-initiated node-data patch so the editor's
  // history hook can push a debounced snapshot (or, for destructive mix-remove
  // actions, a fresh snapshot with a per-edge tag).
  onBeforeEdit: (tag: string) => void;
}

export function Inspector({
  selectedId, nodes, edges, jobId, outputs, outputAudioUrl, onClose,
  sourceState, onSourceFromUrl, onSourceFromFile, onResetSource,
  onRun, onCancel, runDisabled, runStatus, presetLoadKey, onBeforeEdit,
}: Props) {
  const { updateNodeData, setEdges } = useReactFlow();
  const node = useMemo(
    () => (selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, nodes],
  );

  const d = node ? (node.data as any) : null;
  // Tag is derived from patch keys so each field type coalesces into its own
  // debounce bucket — typing into tempo_ratio builds one undo entry, then
  // dragging a mix gain builds a separate one.
  const update = node
    ? (patch: Record<string, unknown>) => {
        const tag = Object.keys(patch).sort().join(',') + `@${node.id}`;
        onBeforeEdit(tag);
        updateNodeData(node.id, patch);
      }
    : () => {};

  // Destructive mix-input disconnect. Uses a unique per-edge tag so two
  // back-to-back removes don't coalesce into a single undo entry.
  const removeEdgeForMix = node
    ? (edgeId: string) => {
        onBeforeEdit(`mix-remove:${edgeId}`);
        setEdges((prev) => prev.filter((e) => e.id !== edgeId));
      }
    : () => {};

  return (
    <div className="w-72 border-l border-gruvbox-bg2 bg-gruvbox-bg flex flex-col">
      {node ? (
        <>
          <div className="px-3 py-2 border-b border-gruvbox-bg2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: nodeTypeColor(node.type) }}
              />
              <span className="text-[11px] uppercase tracking-wider font-bold" style={{ color: nodeTypeColor(node.type) }}>
                {node.type}
              </span>
              <span className="text-[10px] text-gruvbox-fg4">{node.id}</span>
            </div>
            <button
              onClick={onClose}
              className="text-gruvbox-fg4 hover:text-gruvbox-fg text-xs"
            >
              ×
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3 text-[11px]">
            {node.type === 'source' && (
              <SourceInspector
                key={presetLoadKey}
                sourceState={sourceState}
                onSourceFromUrl={onSourceFromUrl}
                onSourceFromFile={onSourceFromFile}
                onResetSource={onResetSource}
              />
            )}
            {node.type === 'split' && <SplitInspector data={d} update={update} />}
            {node.type === 'mix' && (
              <MixInspector nodeId={node.id} data={d} edges={edges} update={update} removeEdge={removeEdgeForMix} />
            )}
            {node.type === 'pitch_speed' && (
              <PitchSpeedInspector data={d} update={update} />
            )}
            {node.type === 'output' && (
              <OutputInspector
                nodeId={node.id}
                data={d}
                jobId={jobId}
                outputs={outputs}
                outputAudioUrl={outputAudioUrl}
                update={update}
              />
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 p-4 text-[11px] text-gruvbox-fg4">
          Click a node to inspect it.
        </div>
      )}

      {/* Run button — always at the bottom. Doubles as Cancel while running:
          click triggers onCancel, and hovering swaps the label/icon and the
          background to red so the cancel affordance is unambiguous. */}
      <div className="p-3 border-t border-gruvbox-bg2">
        <div className="flex justify-center py-6">
          <StemmonDancer size={208} dancing={runStatus === 'running'} />
        </div>
        <button
          onClick={runStatus === 'running' ? onCancel : onRun}
          disabled={runDisabled}
          title={runStatus === 'running' ? 'click to cancel' : undefined}
          className={`group w-full px-[15px] py-[13px] text-[24px] font-bold uppercase tracking-wider rounded-md
                     text-gruvbox-bg-h shadow-lg transition-all
                     inline-flex items-center justify-center gap-[8px]
                     disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none
                     ${runStatus === 'running'
                       ? 'bg-gruvbox-orange shadow-gruvbox-orange/30 hover:bg-gruvbox-red hover:shadow-gruvbox-red/40'
                       : 'bg-gruvbox-orange shadow-gruvbox-orange/30 hover:brightness-110 hover:shadow-gruvbox-orange/50'}`}
        >
          {runStatus === 'running' ? (
            <>
              {/* Default (non-hover) content: spinner + Running */}
              <span className="group-hover:hidden inline-flex items-center gap-[8px]">
                <svg
                  className="animate-spin"
                  width="15" height="15" viewBox="0 0 24 24" fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                  <path d="M4 12a8 8 0 0 1 8-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                </svg>
                Running
              </span>
              {/* Hover content: stop square + Cancel */}
              <span className="hidden group-hover:inline-flex items-center gap-[8px]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="5" y="5" width="14" height="14" rx="1.5" />
                </svg>
                Cancel
              </span>
            </>
          ) : (
            <>▶ Run</>
          )}
        </button>
      </div>
    </div>
  );
}

// ---- Source ----------------------------------------------------------

function SourceInspector({
  sourceState, onSourceFromUrl, onSourceFromFile, onResetSource,
}: {
  sourceState: SourceState;
  onSourceFromUrl: (url: string) => Promise<void>;
  onSourceFromFile: (file: File) => Promise<void>;
  onResetSource: () => void;
}) {
  const [url, setUrl] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submitUrl = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setSubmitError(null);
    try {
      await onSourceFromUrl(trimmed);
      setUrl('');
    } catch (e: any) {
      setSubmitError(e.message ?? String(e));
    }
  };

  const submitFile = async (file: File) => {
    setSubmitError(null);
    try {
      await onSourceFromFile(file);
    } catch (e: any) {
      setSubmitError(e.message ?? String(e));
    }
  };

  if (sourceState.status === 'ready') {
    return (
      <div className="space-y-3">
        {sourceState.thumbnail && (
          <img src={sourceState.thumbnail} alt="" className="w-full aspect-video object-cover rounded" />
        )}
        <div className="text-gruvbox-fg font-semibold truncate" title={sourceState.title}>
          {sourceState.title || 'loaded audio'}
        </div>
        <div className="text-[10px] text-gruvbox-green uppercase tracking-wider">ready</div>
        <button
          onClick={onResetSource}
          className="w-full px-3 py-1.5 text-[11px] rounded
                     bg-gruvbox-bg2 text-gruvbox-fg3 hover:bg-gruvbox-bg3"
        >
          change source
        </button>
      </div>
    );
  }

  if (sourceState.status === 'downloading') {
    return (
      <div className="space-y-3">
        {sourceState.thumbnail && (
          <img src={sourceState.thumbnail} alt="" className="w-full aspect-video object-cover rounded" />
        )}
        {sourceState.title && (
          <div className="text-gruvbox-fg font-semibold truncate" title={sourceState.title}>
            {sourceState.title}
          </div>
        )}
        <div className="text-[10px] text-gruvbox-fg4 uppercase">
          {sourceState.stage || 'loading'} · {Math.round(sourceState.progress)}%
        </div>
        <div className="h-1.5 bg-gruvbox-bg1 rounded overflow-hidden">
          <div
            className="h-full bg-gruvbox-blue transition-all"
            style={{ width: `${sourceState.progress}%` }}
          />
        </div>
        <button
          onClick={onResetSource}
          className="w-full px-3 py-1.5 text-[11px] rounded
                     bg-gruvbox-bg2 text-gruvbox-fg3 hover:bg-gruvbox-bg3"
        >
          cancel
        </button>
      </div>
    );
  }

  // empty or error
  return (
    <div className="space-y-3">
      <Field label="youtube url">
        <div className="flex gap-1">
          <input
            autoFocus
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
            placeholder="https://youtube.com/watch?v=..."
            className="flex-1 bg-gruvbox-bg1 border border-gruvbox-bg3 rounded px-2 py-1 text-gruvbox-fg text-[11px]"
          />
          <button
            onClick={submitUrl}
            disabled={!url.trim()}
            className="px-3 py-1 text-[11px] rounded
                       bg-gruvbox-orange text-gruvbox-bg-h font-semibold
                       hover:brightness-110 disabled:opacity-40"
          >
            load
          </button>
        </div>
      </Field>

      <div className="flex items-center gap-2 text-[10px] text-gruvbox-fg4">
        <div className="flex-1 h-px bg-gruvbox-bg2" />
        <span>or</span>
        <div className="flex-1 h-px bg-gruvbox-bg2" />
      </div>

      <div>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) submitFile(f);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="w-full px-3 py-1.5 text-[11px] rounded
                     border border-gruvbox-bg3 text-gruvbox-fg3
                     hover:bg-gruvbox-bg1"
        >
          ↑ upload audio file
        </button>
      </div>

      {(submitError || sourceState.error) && (
        <div className="text-[10px] text-gruvbox-red">
          {submitError || sourceState.error}
        </div>
      )}
    </div>
  );
}

// ---- Split -----------------------------------------------------------

function SplitInspector({ data, update }: { data: any; update: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="model">
        <select
          value={data.model}
          onChange={(e) => update({ model: e.target.value as DemucsModel })}
          className="w-full bg-gruvbox-bg1 border border-gruvbox-bg3 rounded px-2 py-1 text-gruvbox-fg text-[11px]"
        >
          <option value="htdemucs_6s">htdemucs_6s (6-stem)</option>
          <option value="htdemucs">htdemucs (4-stem)</option>
          <option value="htdemucs_ft">htdemucs_ft (4-stem fine-tuned)</option>
        </select>
      </Field>
      <SliderField label="shifts" value={data.n_shifts} min={0} max={10} step={1}
        onChange={(v) => update({ n_shifts: v })}
        hint="Average over N random time-shifts. Higher = cleaner, slower." />
      <CheckField label="normalize before" value={data.normalize_before}
        onChange={(v) => update({ normalize_before: v })}
        hint="LUFS-normalize input before Demucs." />
      <CheckField label="normalize after" value={data.normalize_after}
        onChange={(v) => update({ normalize_after: v })}
        hint="LUFS-normalize each stem after Demucs." />
    </div>
  );
}

// ---- Pitch/Speed -----------------------------------------------------

function PitchSpeedInspector({
  data, update,
}: { data: any; update: (p: Record<string, unknown>) => void }) {
  const pitch: number = typeof data.pitch_semitones === 'number' ? data.pitch_semitones : 0;
  const tempo: number = typeof data.tempo_ratio === 'number' ? data.tempo_ratio : 1.0;
  const inputCount = Array.isArray(data.inputs) ? data.inputs.length : 0;
  const identity = pitch === 0 && tempo === 1.0;

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-gruvbox-fg4">
        {inputCount} input{inputCount === 1 ? '' : 's'}
        {identity && ' · passthrough'}
      </div>
      <SliderField label="pitch (semitones)" value={pitch} min={-24} max={24} step={0.5}
        onChange={(v) => update({ pitch_semitones: v })} />
      <SliderField label="tempo" value={tempo} min={0.25} max={4} step={0.05}
        onChange={(v) => update({ tempo_ratio: v })} />
      <div className="flex gap-2">
        <button
          onClick={() => update({ pitch_semitones: 0, tempo_ratio: 1.0 })}
          className="flex-1 px-2 py-1 text-[10px] rounded
                     bg-gruvbox-bg2 text-gruvbox-fg3 hover:bg-gruvbox-bg3"
        >
          reset
        </button>
      </div>
    </div>
  );
}

// ---- Mix -------------------------------------------------------------

function MixInspector({
  nodeId, data, edges, update, removeEdge,
}: {
  nodeId: string; data: any; edges: Edge[];
  update: (p: Record<string, unknown>) => void;
  removeEdge: (edgeId: string) => void;
}) {
  const incoming = edges
    .filter((e) => e.target === nodeId)
    .sort((a, b) => (a.targetHandle || '').localeCompare(b.targetHandle || ''));

  const inputs: Array<{ source_node: string; source_port: string; gain: number }> = data.inputs ?? [];

  const getGain = (src: string, port: string): number => {
    const hit = inputs.find((i) => i.source_node === src && i.source_port === port);
    return hit?.gain ?? 1.0;
  };

  const setGain = (src: string, port: string, gain: number) => {
    const merged = incoming.map((e) => {
      const p = e.sourceHandle ?? 'out';
      const thisMatch = e.source === src && p === port;
      return {
        source_node: e.source!,
        source_port: p,
        gain: thisMatch ? gain : getGain(e.source!, p),
      };
    });
    update({ inputs: merged });
  };

  if (incoming.length === 0) {
    return (
      <div className="text-gruvbox-fg4">
        No inputs connected. Drag edges from Source or Split outputs into the Mix node.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-gruvbox-fg4">
        {incoming.length} input{incoming.length === 1 ? '' : 's'} · gains −2 to +2. Output = sum of (input × gain), clipped.
      </div>
      {incoming.map((e) => {
        const port = e.sourceHandle ?? 'out';
        const gain = getGain(e.source!, port);
        const negative = gain < 0;
        return (
          <div key={e.id} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-gruvbox-fg3 text-[11px] flex-1 truncate" title={`${e.source}:${port}`}>
                {e.source}:{port}
              </span>
              <button
                onClick={() => removeEdge(e.id)}
                className="text-gruvbox-red/70 hover:text-gruvbox-red text-[10px]"
                title="disconnect"
              >
                ×
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={-2}
                max={2}
                step={0.05}
                value={gain}
                onChange={(ev) => setGain(e.source!, port, Number(ev.target.value))}
                className="flex-1"
              />
              <span className={`w-12 text-right text-[11px] tabular-nums ${negative ? 'text-gruvbox-red' : 'text-gruvbox-fg3'}`}>
                {gain > 0 ? '+' : ''}{gain.toFixed(2)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Output ----------------------------------------------------------

function OutputInspector({
  nodeId, data, jobId, outputs, outputAudioUrl, update,
}: {
  nodeId: string;
  data: any;
  jobId: string | null;
  outputs: Record<string, { label: string; hash: string }>;
  outputAudioUrl: (jobId: string, nodeId: string) => string;
  update: (p: Record<string, unknown>) => void;
}) {
  const hasResult = jobId !== null && !!outputs[nodeId];
  const url = jobId ? outputAudioUrl(jobId, nodeId) : '';

  const download = () => {
    if (!hasResult) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.label || nodeId}.wav`;
    a.click();
  };

  return (
    <div className="space-y-3">
      <Field label="label">
        <input
          type="text"
          value={data.label}
          onChange={(e) => update({ label: e.target.value })}
          className="w-full bg-gruvbox-bg1 border border-gruvbox-bg3 rounded px-2 py-1 text-gruvbox-fg text-[11px]"
          placeholder="output label"
        />
      </Field>

      <div>
        <button
          onClick={download}
          disabled={!hasResult}
          className="w-full px-3 py-1.5 text-[11px] font-semibold rounded
                     bg-gruvbox-bg2 text-gruvbox-fg3 hover:bg-gruvbox-bg3
                     disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ↓ download wav
        </button>
      </div>

      {!hasResult && (
        <div className="text-[10px] text-gruvbox-fg4">Run the graph to produce this output.</div>
      )}
    </div>
  );
}

// ---- Helpers ---------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gruvbox-fg4 mb-1">{label}</div>
      {children}
    </div>
  );
}

function SliderField({
  label, value, min, max, step, onChange, hint,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-gruvbox-fg4">{label}</span>
        <span className="text-[11px] text-gruvbox-fg3 tabular-nums">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
      {hint && <div className="text-[10px] text-gruvbox-fg4 mt-1">{hint}</div>}
    </div>
  );
}

function CheckField({
  label, value, onChange, hint,
}: {
  label: string; value: boolean; onChange: (v: boolean) => void; hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-gruvbox-blue"
      />
      <div>
        <div className="text-[11px] text-gruvbox-fg3">{label}</div>
        {hint && <div className="text-[10px] text-gruvbox-fg4">{hint}</div>}
      </div>
    </label>
  );
}

