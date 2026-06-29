'use client';
import { useState } from 'react';
import { fmtAgo } from '../lib/format';
import RestartButton from './RestartButton';

export default function SystemPanel({ state, config }) {
  const [exportLoading, setExportLoading] = useState(false);
  const [zipLoading, setZipLoading] = useState(false);
  const [feedLoading, setFeedLoading] = useState(false);
  const [exportResult, setExportResult] = useState(null);
  const [feedResult, setFeedResult] = useState(null);

  async function exportTraining() {
    setExportLoading(true);
    setExportResult(null);
    try {
      const res = await fetch('/api/laminar/training', { method: 'POST' });
      const json = await res.json();
      setExportResult(json);
    } catch (e) {
      setExportResult({ ok: false, error: e.message });
    } finally {
      setExportLoading(false);
    }
  }

  async function downloadZip() {
    setZipLoading(true);
    try {
      const res = await fetch('/api/laminar/training/zip', { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setExportResult({ ok: false, error: json.error || `HTTP ${res.status}` });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const filenameMatch = disposition.match(/filename="?([^";]+)"?/);
      const filename = filenameMatch?.[1] || 'laminar-scout-training.zip';

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setExportResult({ ok: true, message: 'ZIP download started' });
    } catch (e) {
      setExportResult({ ok: false, error: e.message });
    } finally {
      setZipLoading(false);
    }
  }

  async function exportFeed() {
    setFeedLoading(true);
    setFeedResult(null);
    try {
      const res = await fetch('/api/laminar/smart-wallets', { method: 'POST' });
      const json = await res.json();
      setFeedResult(json);
    } catch (e) {
      setFeedResult({ ok: false, error: e.message });
    } finally {
      setFeedLoading(false);
    }
  }

  const cycles = [
    { label: 'Discovery', at: state?.lastDiscoveryAt },
    { label: 'Screening', at: state?.lastScreeningAt },
    { label: 'Snapshot', at: state?.lastSnapshotAt },
    { label: 'Ranking', at: state?.lastRankingAt },
    { label: 'Signal', at: state?.lastSignalAt },
    { label: 'Token Info', at: state?.lastTokenInfoAt },
  ];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="panel">
        <div className="panel-header">Cycle Status</div>
        <div className="panel-body cycle-grid">
          {cycles.map((c) => (
            <div key={c.label} className="cycle-item">
              <div className="small">{c.label}</div>
              <div className="value-small">{c.at ? fmtAgo(c.at) : '—'}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">Laminar Export Actions</div>
        <div className="panel-body" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button onClick={exportTraining} disabled={exportLoading || zipLoading}>
            {exportLoading ? 'Exporting…' : 'Export Training Files'}
          </button>
          <button className="secondary" onClick={downloadZip} disabled={exportLoading || zipLoading}>
            {zipLoading ? 'Building ZIP…' : 'Download Training ZIP'}
          </button>
          <button className="secondary" onClick={exportFeed} disabled={feedLoading}>
            {feedLoading ? 'Exporting…' : 'Export Smart-Wallet Feed'}
          </button>
        </div>

        <div className="panel-body small dim" style={{ paddingTop: 0 }}>
          Export training menulis ~1.5GB file JSON/JSONL dari DB. Proses bisa memakan waktu 10-30 detik.
        </div>

        {exportResult && (
          <div className="panel-body small" style={{ borderTop: '1px solid var(--border)' }}>
            {exportResult.ok ? (
              <span className="green">
                {exportResult.performanceCount ? (
                  <>
                    Training export: {exportResult.performanceCount.toLocaleString()} perf /{' '}
                    {exportResult.lessonCount.toLocaleString()} lessons /{' '}
                    {exportResult.tracesCount.toLocaleString()} traces
                    {exportResult.lessonsPath && (
                      <span className="dim" style={{ display: 'block', marginTop: 4 }}>
                        {exportResult.lessonsPath.replace(/^.*\/(dataset\/)/, '$1')}
                      </span>
                    )}
                  </>
                ) : (
                  exportResult.message || 'Export complete'
                )}
              </span>
            ) : (
              <span className="red">Export failed: {exportResult.error || exportResult.message}</span>
            )}
          </div>
        )}

        {feedResult && (
          <div className="panel-body small" style={{ borderTop: '1px solid var(--border)' }}>
            {feedResult.ok ? (
              <span className="green">Smart-wallet feed: {feedResult.count} wallet(s)</span>
            ) : (
              <span className="red">Feed failed: {feedResult.error || feedResult.message}</span>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">Configuration</div>
        <div className="panel-body config-grid">
          <ConfigBlock title="Discovery" data={config?.discovery} />
          <ConfigBlock title="Screening" data={config?.screening} />
          <ConfigBlock title="Tiers" data={config?.tiers} />
          <ConfigBlock title="Signals" data={config?.signals} />
          <ConfigBlock title="Collection" data={config?.collection} />
          <ConfigBlock title="Output" data={config?.output} />
        </div>
      </div>

      <RestartButton />
    </div>
  );
}

function ConfigBlock({ title, data }) {
  if (!data) return null;
  return (
    <div className="config-block">
      <div className="small" style={{ marginBottom: 6 }}>{title}</div>
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="config-row" title={`${k}: ${Array.isArray(v) ? JSON.stringify(v) : String(v ?? '—')}`}>
          <span className="dim">{k}</span>
          <span className="mono">{Array.isArray(v) ? JSON.stringify(v) : String(v ?? '—')}</span>
        </div>
      ))}
    </div>
  );
}
