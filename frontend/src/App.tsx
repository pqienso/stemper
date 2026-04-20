import { useEffect, useState } from 'react';
import { GraphEditor } from './graph/GraphEditor';
import { getPresets } from './graph/api';
import type { PresetMeta } from './graph/types';

function App() {
  const [presets, setPresets] = useState<PresetMeta[] | null>(null);

  useEffect(() => {
    getPresets().then(setPresets).catch(console.error);
  }, []);

  if (!presets) return <main className="h-screen bg-gruvbox-bg-h" />;
  const defaultPreset = presets.find((p) => p.id === 'default_6stem') ?? presets[0];
  if (!defaultPreset) return <main className="h-screen bg-gruvbox-bg-h" />;

  return (
    <main className="h-screen bg-gruvbox-bg-h">
      <GraphEditor initialGraph={defaultPreset.graph} presets={presets} />
    </main>
  );
}

export default App;
