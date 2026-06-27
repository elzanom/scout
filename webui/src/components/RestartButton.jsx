'use client';
import { useState } from 'react';

export default function RestartButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function restart() {
    if (!confirm('Restart laminar-scout? The process will shut down gracefully and must be respawned by PM2 or manually.')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/control/restart', { method: 'POST' });
      const json = await res.json();
      setResult(json);
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="danger" onClick={restart} disabled={busy}>{busy ? 'Restarting…' : 'Restart'}</button>
      {result && (
        <div className="small" style={{ marginTop: 6, color: result.ok ? 'var(--accent-2)' : 'var(--danger)' }}>
          {result.ok ? 'Restart signal sent.' : `Failed: ${result.error || result.message}`}
        </div>
      )}
    </div>
  );
}
