'use client';
import { fmtNumber, fmtAgo } from '../lib/format';

export default function StatCards({ state }) {
  const cards = [
    { label: 'Wallets', value: state?.wallets ?? '—', color: 'var(--accent)' },
    { label: 'Top Wallets', value: state?.topWallets ?? '—', color: 'var(--accent-2)' },
    { label: 'Open Positions', value: state?.openPositions ?? '—', color: 'var(--accent-3)' },
    { label: 'Closed Positions', value: state?.closedPositions ?? '—', color: 'var(--purple)' },
    { label: 'Signals Today', value: state?.signalsToday ?? '—', color: 'var(--pink)' },
    { label: 'Snapshots', value: state?.snapshots ?? '—', color: 'var(--warn)' },
  ];

  return (
    <div className="stat-grid">
      {cards.map((c) => (
        <div key={c.label} className="stat-card" style={{ borderLeftColor: c.color }}>
          <div className="label">{c.label}</div>
          <div className="value" style={{ color: c.color }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

export function CycleSummary({ state }) {
  const cycles = [
    { label: 'Discovery', at: state?.lastDiscoveryAt },
    { label: 'Screening', at: state?.lastScreeningAt },
    { label: 'Snapshot', at: state?.lastSnapshotAt },
    { label: 'Ranking', at: state?.lastRankingAt },
    { label: 'Signal', at: state?.lastSignalAt },
    { label: 'Token Info', at: state?.lastTokenInfoAt },
  ];

  return (
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
  );
}
