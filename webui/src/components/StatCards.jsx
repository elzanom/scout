'use client';
import { fmtNumber, fmtAgo } from '../lib/format';

export default function StatCards({ state }) {
  const cards = [
    { label: 'Wallets', value: state?.wallets ?? '—' },
    { label: 'Top Wallets', value: state?.topWallets ?? '—' },
    { label: 'Open Positions', value: state?.openPositions ?? '—' },
    { label: 'Closed Positions', value: state?.closedPositions ?? '—' },
    { label: 'Signals Today', value: state?.signalsToday ?? '—' },
    { label: 'Latest Snapshot', value: fmtAgo(state?.latestSnapshotAt), sub: state?.latestSnapshotPool ? shortenPool(state.latestSnapshotPool) : '' },
  ];

  return (
    <div className="stat-grid">
      {cards.map((c) => (
        <div key={c.label} className="stat-card">
          <div className="label">{c.label}</div>
          <div className="value">{c.value}</div>
          {c.sub && <div className="sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function shortenPool(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
