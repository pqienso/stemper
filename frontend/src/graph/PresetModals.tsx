import { useEffect, useState } from 'react';
import type { GraphSpec, PresetMeta } from './types';

type RowMode = 'edit' | 'confirm-delete' | 'confirm-overwrite';

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gruvbox-bg-h/70"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[520px] max-h-[85vh] flex flex-col rounded-md border border-gruvbox-bg3 bg-gruvbox-bg shadow-2xl">
        {children}
      </div>
    </div>
  );
}

export function PresetsModal({
  builtIn,
  saved,
  currentGraph,
  onClose,
  onLoad,
  onSave,
  onUpdate,
  onDelete,
  onExport,
  onImport,
}: {
  builtIn: PresetMeta[];
  saved: PresetMeta[];
  currentGraph: GraphSpec;
  onClose: () => void;
  onLoad: (p: PresetMeta) => void;
  onSave: (name: string, description: string) => void;
  onUpdate: (id: string, patch: { name?: string; description?: string; graph?: GraphSpec }) => void;
  onDelete: (id: string) => void;
  onExport: (p: PresetMeta) => void;
  onImport: (text: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');

  const [activeRow, setActiveRow] = useState<{ id: string; mode: RowMode } | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const startEdit = (p: PresetMeta) => {
    setActiveRow({ id: p.id, mode: 'edit' });
    setEditName(p.name);
    setEditDesc(p.description ?? '');
  };
  const cancelRow = () => setActiveRow(null);
  const submitEdit = () => {
    if (!activeRow) return;
    onUpdate(activeRow.id, { name: editName, description: editDesc });
    setActiveRow(null);
  };

  const submitSave = () => {
    if (!saveName.trim()) return;
    onSave(saveName, saveDesc);
    setSaving(false);
    setSaveName('');
    setSaveDesc('');
  };

  const submitImport = () => {
    setImportError(null);
    try {
      onImport(importText);
      setImporting(false);
      setImportText('');
    } catch (e: any) {
      setImportError(e.message ?? String(e));
    }
  };

  const handleExport = (p: PresetMeta) => {
    onExport(p);
    setCopiedId(p.id);
    window.setTimeout(() => setCopiedId((cur) => (cur === p.id ? null : cur)), 1500);
  };

  return (
    <ModalShell onClose={onClose}>
      <div className="px-4 py-3 border-b border-gruvbox-bg2 flex items-center justify-between">
        <div className="text-[13px] font-bold uppercase tracking-wider text-gruvbox-fg">Presets</div>
        <button
          onClick={onClose}
          className="text-gruvbox-fg4 hover:text-gruvbox-fg text-lg leading-none"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Save current */}
        <div className="px-4 pt-3 pb-3 border-b border-gruvbox-bg2">
          {saving ? (
            <div className="space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-gruvbox-fg4">
                Save current graph as preset
              </div>
              <input
                autoFocus
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitSave();
                }}
                placeholder="Name"
                className="w-full bg-gruvbox-bg1 border border-gruvbox-bg3 rounded px-2 py-1.5 text-[13px] text-gruvbox-fg"
              />
              <textarea
                value={saveDesc}
                onChange={(e) => setSaveDesc(e.target.value)}
                rows={2}
                placeholder="Description (optional)"
                className="w-full bg-gruvbox-bg1 border border-gruvbox-bg3 rounded px-2 py-1.5 text-[12px] text-gruvbox-fg"
              />
              <div className="flex gap-2 justify-end">
                <FooterButton onClick={() => { setSaving(false); setSaveName(''); setSaveDesc(''); }}>
                  Cancel
                </FooterButton>
                <FooterButton primary disabled={!saveName.trim()} onClick={submitSave}>
                  Save
                </FooterButton>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setSaving(true)}
              className="w-full px-3 py-1.5 text-[12px] font-semibold rounded
                         bg-gruvbox-orange text-gruvbox-bg-h shadow shadow-gruvbox-orange/30
                         hover:brightness-110 hover:shadow-gruvbox-orange/50 transition-all
                         uppercase tracking-wider"
            >
              + Save current graph as preset
            </button>
          )}
        </div>

        <Section title="Built-in">
          {builtIn.length === 0 && <Empty text="No built-in presets." />}
          {builtIn.map((p) => (
            <PresetRow key={p.id} preset={p} onLoad={() => onLoad(p)} />
          ))}
        </Section>

        <Section title="Saved">
          {saved.length === 0 && (
            <Empty text='No saved presets yet. Use "+ Save current graph as preset" above.' />
          )}
          {saved.map((p) => {
            const active = activeRow?.id === p.id ? activeRow.mode : null;
            if (active === 'edit') {
              return (
                <div key={p.id} className="px-4 py-3 border-b border-gruvbox-bg2 last:border-b-0 bg-gruvbox-bg1 space-y-2">
                  <input
                    autoFocus
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitEdit();
                      if (e.key === 'Escape') cancelRow();
                    }}
                    placeholder="Name"
                    className="w-full bg-gruvbox-bg border border-gruvbox-bg3 rounded px-2 py-1.5 text-[13px] text-gruvbox-fg"
                  />
                  <textarea
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    rows={2}
                    placeholder="Description (optional)"
                    className="w-full bg-gruvbox-bg border border-gruvbox-bg3 rounded px-2 py-1.5 text-[12px] text-gruvbox-fg"
                  />
                  <div className="flex gap-2 justify-end">
                    <FooterButton onClick={cancelRow}>Cancel</FooterButton>
                    <FooterButton primary disabled={!editName.trim()} onClick={submitEdit}>
                      Save
                    </FooterButton>
                  </div>
                </div>
              );
            }

            return (
              <PresetRow
                key={p.id}
                preset={p}
                onLoad={() => onLoad(p)}
                disableLoadOnClick={active !== null}
                actions={
                  active === 'confirm-overwrite' ? (
                    <InlineConfirm
                      label="Overwrite with current graph?"
                      confirmLabel="Overwrite"
                      onConfirm={() => {
                        onUpdate(p.id, { graph: currentGraph });
                        setActiveRow(null);
                      }}
                      onCancel={cancelRow}
                      danger
                    />
                  ) : active === 'confirm-delete' ? (
                    <InlineConfirm
                      label="Delete this preset?"
                      confirmLabel="Delete"
                      onConfirm={() => {
                        onDelete(p.id);
                        setActiveRow(null);
                      }}
                      onCancel={cancelRow}
                      danger
                    />
                  ) : (
                    <>
                      <RowButton
                        onClick={(e) => { e.stopPropagation(); startEdit(p); }}
                        title="rename or edit description"
                      >
                        Edit
                      </RowButton>
                      <RowButton
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveRow({ id: p.id, mode: 'confirm-overwrite' });
                        }}
                        title="replace with current graph"
                      >
                        Overwrite
                      </RowButton>
                      <RowButton
                        onClick={(e) => { e.stopPropagation(); handleExport(p); }}
                        title="copy JSON to clipboard"
                      >
                        {copiedId === p.id ? 'Copied' : 'Export'}
                      </RowButton>
                      <RowButton
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveRow({ id: p.id, mode: 'confirm-delete' });
                        }}
                        danger
                      >
                        Delete
                      </RowButton>
                    </>
                  )
                }
              />
            );
          })}
        </Section>
      </div>

      <div className="border-t border-gruvbox-bg2 px-4 py-3">
        {importing ? (
          <div className="space-y-2">
            <textarea
              autoFocus
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="Paste preset or graph JSON here…"
              rows={5}
              className="w-full text-[11px] font-mono rounded bg-gruvbox-bg1 border border-gruvbox-bg3 px-2 py-1 text-gruvbox-fg"
            />
            {importError && <div className="text-[11px] text-gruvbox-red">{importError}</div>}
            <div className="flex gap-2 justify-end">
              <FooterButton onClick={() => { setImporting(false); setImportText(''); setImportError(null); }}>
                Cancel
              </FooterButton>
              <FooterButton primary disabled={!importText.trim()} onClick={submitImport}>
                Import
              </FooterButton>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setImporting(true)}
            className="w-full px-3 py-1.5 text-[12px] rounded border border-dashed border-gruvbox-bg3 text-gruvbox-fg3 hover:bg-gruvbox-bg1 hover:text-gruvbox-fg"
          >
            ↑ Import preset JSON
          </button>
        )}
      </div>
    </ModalShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gruvbox-fg4">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-2 text-[11px] text-gruvbox-fg4 italic">{text}</div>;
}

function PresetRow({
  preset,
  onLoad,
  actions,
  disableLoadOnClick,
}: {
  preset: PresetMeta;
  onLoad: () => void;
  actions?: React.ReactNode;
  disableLoadOnClick?: boolean;
}) {
  return (
    <div
      onClick={disableLoadOnClick ? undefined : onLoad}
      className={`group px-4 py-2 border-b border-gruvbox-bg2 last:border-b-0 flex items-start gap-3
                  ${disableLoadOnClick ? '' : 'hover:bg-gruvbox-bg1 cursor-pointer'}`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-gruvbox-fg truncate">{preset.name}</div>
        {preset.description && (
          <div className="text-[11px] text-gruvbox-fg4 mt-0.5">{preset.description}</div>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
}

function RowButton({
  onClick,
  children,
  danger,
  title,
}: {
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-2 py-0.5 text-[11px] rounded border transition-colors ${
        danger
          ? 'border-gruvbox-red/40 text-gruvbox-red hover:bg-gruvbox-red/10'
          : 'border-gruvbox-bg3 text-gruvbox-fg3 hover:bg-gruvbox-bg2 hover:text-gruvbox-fg'
      }`}
    >
      {children}
    </button>
  );
}

function InlineConfirm({
  label,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 opacity-100">
      <span className="text-[11px] text-gruvbox-fg3">{label}</span>
      <RowButton onClick={(e) => { e.stopPropagation(); onConfirm(); }} danger={danger}>
        {confirmLabel}
      </RowButton>
      <RowButton onClick={(e) => { e.stopPropagation(); onCancel(); }}>
        Cancel
      </RowButton>
    </div>
  );
}

function FooterButton({
  onClick,
  children,
  primary,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-[12px] rounded font-semibold transition-all disabled:opacity-40 ${
        primary
          ? 'bg-gruvbox-orange text-gruvbox-bg-h hover:brightness-110'
          : 'bg-gruvbox-bg1 text-gruvbox-fg3 hover:bg-gruvbox-bg2'
      }`}
    >
      {children}
    </button>
  );
}
