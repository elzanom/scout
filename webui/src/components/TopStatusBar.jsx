'use client';
import { fmtAgo } from '../lib/format';

export default function TopStatusBar({ state, connected }) {
  const wallets = state?.wallets ?? '—';
  const top = state?.topWallets ?? '—';
  const open = state?.openPositions ?? '—';
  const signals = state?.signalsToday ?? '—';
  const latest = state?.latestSnapshotAt ? fmtAgo(state.latestSnapshotAt) : '—';

  return (
    <div className="status-bar">
      <div className="status-pill">
        <span className={`dot ${connected ? 'live' : 'offline'}`} />
        <b>{connected ? 'LIVE' : 'OFFLINE'}</b>
      </div>
      <div className="status-pill"><b>{wallets}</b> wallets</div>
      <div className="status-pill"><b className="cyan">{top}</b> top</div>
      <div className="status-pill"><b>{open}</b> open</div>
      <div className="status-pill"><b>{signals}</b> signals today</div>
      <div className="status-pill small">updated {latest}</div>
    </div>
  );
}
