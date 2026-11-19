import { timeline, type Timeline } from './music.ts';

interface Status { id: string; state: string; analysis_fraction: number | null; error?: {message: string} }
export interface Observer {
  upload: (fraction: number) => void;
  status: (status: Status) => void;
  reconnect: () => void;
  ready: (t: Timeline) => void;
  failed: (message: string) => void;
}
const base = '/v1/jobs';
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
function retire(id: string) {
  void fetch(`${base}/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}
function upload(id: string, file: File, signal: AbortSignal, progress: Observer['upload']) {
  return new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    const abort = () => x.abort();
    x.open('PUT', `${base}/${id}/audio`);
    x.setRequestHeader('Content-Type', 'audio/mpeg');
    x.responseType = 'json';
    x.upload.onprogress = e => progress(Math.min(1, e.loaded / file.size));
    x.onload = () => x.status === 202 ? resolve() : reject(Error(x.response?.error?.message || 'Upload rejected.'));
    x.onerror = x.onabort = () => reject(Error('Upload interrupted.'));
    x.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    x.send(file);
  });
}

// One instance per page, with a fresh generation even when retrying the same File.
export class Jobs {
  generation = 0;
  private id = '';
  private control = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  cancel() {
    ++this.generation;
    clearTimeout(this.timer);
    this.control.abort();
    if (this.id) retire(this.id);
    this.id = '';
  }
  async start(file: File, view: Observer) {
    this.cancel();
    const gen = this.generation;
    const live = () => gen === this.generation;
    this.control = new AbortController();
    const signal = this.control.signal;
    const fail = (error: unknown) => {
      if (!live()) return;
      this.cancel();
      view.failed(error instanceof Error ? error.message : 'Analysis unavailable.');
    };
    try {
      // Finish reservation even if replaced: DELETE its late ID rather than losing it.
      const r = await fetch(base, { method: 'POST', signal:AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({name: file.name, size_bytes: file.size}) });
      const created = await r.json();
      if (!r.ok || !validId(created.id)) throw Error(created.error?.message || 'Could not reserve the upload.');
      const id: string = created.id;
      if (!live()) { retire(id); return; }
      this.id = id;
      const path = `${base}/${id}`;
      const schedule = () => { if (live()) this.timer = setTimeout(poll, 1000); };
      let succeeded = false;
      let accepted = false;
      let putError: Error | null = null;
      let unconfirmedReads = 0;
      const poll = async () => {
        // An in-flight snapshot may predate a lost PUT response. Only reconcile
        // ambiguous transport failure using a read started after that failure.
        const reconcile = putError;
        try {
          const res = await fetch(succeeded ? `${path}/result` : path,
            {signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]), cache:'no-store'});
          if (!live()) return;
          if (res.status === 404) { fail(Error('Analysis job expired.')); return; }
          if (!res.ok) throw Error('Connection interrupted.');
          const data = await res.json();
          if (!live()) return;
          if (succeeded) {
            try { view.ready(timeline(data)); } catch (e) { fail(e); }
            return;
          }
          if (data.id !== id) { fail(Error('Unexpected job identifier.')); return; }
          if (['queued','analyzing','succeeded'].includes(data.state)) accepted = true;
          view.status(data);
          if (['failed', 'cancelled', 'cancelling'].includes(data.state)) {
            fail(Error(data.error?.message || 'Analysis cancelled.')); return;
          }
          if (data.state === 'succeeded') { succeeded = true; void poll(); return; }
          if (reconcile && !accepted && data.state === 'uploading') { fail(reconcile); return; }
        } catch {
          if (!live()) return;
          if (reconcile && !accepted && ++unconfirmedReads >= 3) { fail(reconcile); return; }
          view.reconnect();
        }
        schedule();
      };
      schedule();
      try {
        await upload(id, file, signal, f => { if (live() && !accepted) view.upload(f); });
        accepted = true;
      } catch (e) {
        if (live() && !accepted) putError = e instanceof Error ? e : Error('Upload interrupted.');
      }
    } catch (e) { fail(e); }
  }
}
