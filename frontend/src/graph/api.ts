import type { GraphSpec, PresetMeta } from './types';

const API_BASE = '/api';

async function apiFetch<T>(path: string, init?: RequestInit, fallbackMessage = 'Request failed'): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || fallbackMessage);
  }
  return res.json();
}

export function createJob(url: string): Promise<{ job_id: string }> {
  return apiFetch('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }, 'Failed to create job');
}

export async function uploadJob(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ job_id: string }> {
  // XHR instead of fetch: fetch has no upload-progress events.
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/jobs/upload`);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) {
        onProgress((e.loaded / e.total) * 100);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Invalid server response'));
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.detail || 'Failed to upload file'));
        } catch {
          reject(new Error(xhr.statusText || 'Failed to upload file'));
        }
      }
    };
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(form);
  });
}

export function runGraph(
  jobId: string,
  graph: GraphSpec,
  jobsPerSplit = 4,
): Promise<{ run_id: string; status: string }> {
  return apiFetch(`/jobs/${jobId}/graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph, jobs_per_split: jobsPerSplit }),
  }, 'Failed to run graph');
}

export function cancelGraph(jobId: string): Promise<{ status: string }> {
  return apiFetch(`/jobs/${jobId}/graph/cancel`, { method: 'POST' }, 'Failed to cancel graph');
}

export function outputAudioUrl(jobId: string, nodeId: string): string {
  return `${API_BASE}/jobs/${jobId}/graph/outputs/${nodeId}`;
}

export async function getPresets(): Promise<PresetMeta[]> {
  const json = await apiFetch<{ presets: PresetMeta[] }>('/presets', undefined, 'Failed to load presets');
  return json.presets;
}

export interface JobEvent {
  type: 'snapshot' | 'job' | 'info' | 'node' | 'run';
  [key: string]: any;
}

export function subscribeToJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  const eventSource = new EventSource(`${API_BASE}/jobs/${jobId}/events`);

  eventSource.onmessage = (event) => {
    if (!event.data) return;
    try {
      onEvent(JSON.parse(event.data));
    } catch (e) {
      console.error('Failed to parse SSE data:', e);
    }
  };

  eventSource.onerror = () => {
    if (onError) onError(new Error('SSE connection error'));
  };

  return () => eventSource.close();
}
