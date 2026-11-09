// Interaction logger: buffers events and posts them to the server every few seconds (and on page hide).
// One JSONL file per session on the server: outputs/annotator/<scene>/logs/<session>.jsonl
export class Logger {
  constructor({ scene, annotator, session }) {
    this.scene = scene;
    this.annotator = annotator;
    this.session = session;
    this.buf = [];
    this.seq = 0;
    this.t0 = performance.now();
    this.url = `api/log/${encodeURIComponent(scene)}`;
    this.timer = setInterval(() => this.flush(), 4000);
    addEventListener('pagehide', () => this.flush(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(true); });
  }

  /** t = wall-clock ms, dt = ms since session start (monotonic), seq orders events within the session. */
  log(type, data = {}) {
    this.buf.push({ seq: this.seq++, t: Date.now(), dt: Math.round(performance.now() - this.t0), type, ...data });
    if (this.buf.length > 400) this.flush();
  }

  flush(beacon = false) {
    if (!this.buf.length) return;
    const events = this.buf.splice(0);
    const body = JSON.stringify({ session: this.session, annotator: this.annotator, events });
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(this.url, new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then((r) => { if (!r.ok) throw new Error(r.status); })
      .catch(() => { this.buf.unshift(...events); });       // keep them for the next attempt
  }
}

export function makeSessionId(annotator) {
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${annotator.replace(/[^A-Za-z0-9_-]/g, '_')}-${ts}-${Math.random().toString(36).slice(2, 6)}`;
}
