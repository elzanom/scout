'use client';
import { fmtNumber, fmtAgo } from '../lib/format';

export default function TopStatusBar({ state, connected }) {
  const pills = [
    { label: 'Latest scan', value: state?.latestSnapshotAt ? `#${state.latestSnapshotAt}` : '—' },
    { label: 'Pools scanned', value: state?.snapshots ?? '—' },
    { label: 'Wallets', value: state?.wallets ?? '—' },
    { label: 'Top wallets', value: state?.topWallets ?? '—' },
    { label: 'Open pos', value: state?.openPositions ?? '—' },
    { label: 'Signals today', value: state?.signalsToday ?? '—' },
  ];

  return (
    <div className="status-bar">
      {pills.map((p) => (
        <div key={p.label} className="status-pill">
          {p.label}: <b>{p.value}</b>
        </div>
      ))}
      <div className="status-pill">
        <span className={`dot ${connected ? 'live' : 'offline'}`} />
        <b>{connected ? 'LIVE' : 'OFFLINE'}</b>
      </div>
      {state?.latestSnapshotAt && (
        <div className="status-pill small">
          updated {fmtAgo(state.latestSnapshotAt)}
        </div>
      )}
    </div>
  );
}
