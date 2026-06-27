'use client';
import { useState, useEffect, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useWebSocket } from '../hooks/useWebSocket';
import TopStatusBar from '../components/TopStatusBar';
import StatCards from '../components/StatCards';
import WalletTable from '../components/WalletTable';
import PositionTable from '../components/PositionTable';
import SignalTable from '../components/SignalTable';
import SnapshotTable from '../components/SnapshotTable';
import PoolChart from '../components/PoolChart';
import LogTail from '../components/LogTail';
import RestartButton from '../components/RestartButton';
import { fmtAgo } from '../lib/format';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'wallets', label: 'Wallets' },
  { key: 'positions', label: 'Positions' },
  { key: 'signals', label: 'Signals' },
  { key: 'pools', label: 'Pools' },
  { key: 'logs', label: 'Logs' },
  { key: 'system', label: 'System' },
];

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [wsUrl, setWsUrl] = useState('');

  const { data: state, refetch: refetchState } = useApi('/api/state');
  const { data: walletsData } = useApi('/api/wallets?limit=200');
  const { data: positionsData } = useApi('/api/positions?limit=200');
  const { data: signalsData } = useApi('/api/signals?limit=100');
  const { data: snapshotsData } = useApi('/api/snapshots?limit=200');
  const { data: poolsData } = useApi('/api/pools');
  const { data: logsData } = useApi('/api/logs?lines=100');

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    setWsUrl(`${proto}//${window.location.host}/ws`);
  }, []);

  const { connected, lastMessage } = useWebSocket(wsUrl);

  const liveState = useMemo(() => {
    if (lastMessage?.type === 'state') return lastMessage.payload;
    return state;
  }, [lastMessage, state]);

  const liveSignals = useMemo(() => {
    if (lastMessage?.type === 'signal' && signalsData?.signals) {
      const next = [lastMessage.payload, ...signalsData.signals];
      return next.slice(0, 100);
    }
    return signalsData?.signals;
  }, [lastMessage, signalsData]);

  const liveSnapshots = useMemo(() => {
    if (lastMessage?.type === 'snapshot' && snapshotsData?.snapshots) {
      const next = [lastMessage.payload, ...snapshotsData.snapshots];
      return next.slice(0, 200);
    }
    return snapshotsData?.snapshots;
  }, [lastMessage, snapshotsData]);

  const liveLogs = useMemo(() => {
    if (lastMessage?.type === 'log' && logsData?.logs) {
      return [...logsData.logs, lastMessage.payload].slice(-100);
    }
    return logsData?.logs;
  }, [lastMessage, logsData]);

  useEffect(() => {
    if (lastMessage?.type === 'state') refetchState();
  }, [lastMessage, refetchState]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <div className="app-title">Laminar Scout Dashboard</div>
          <div className="app-subtitle">Self-discovering LP wallet tracker for Meteora DLMM</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <TopStatusBar state={liveState} connected={connected} />
          <RestartButton />
        </div>
      </header>

      <nav className="app-nav">
        {TABS.map((t) => (
          <div
            key={t.key}
            className={`tab ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </div>
        ))}
      </nav>

      <main className="app-content">
        {activeTab === 'overview' && (
          <div style={{ display: 'grid', gap: 14 }}>
            <StatCards state={liveState} />
            <div>
              <div className="panel-header">Recent Signals</div>
              <SignalTable signals={liveSignals?.slice(0, 8)} />
            </div>
          </div>
        )}

        {activeTab === 'wallets' && (
          <div>
            <div className="panel-header">Wallets</div>
            <WalletTable wallets={walletsData?.wallets} />
          </div>
        )}

        {activeTab === 'positions' && (
          <div>
            <div className="panel-header">Positions</div>
            <PositionTable positions={positionsData?.positions} />
          </div>
        )}

        {activeTab === 'signals' && (
          <div>
            <div className="panel-header">Signals</div>
            <SignalTable signals={liveSignals} />
          </div>
        )}

        {activeTab === 'pools' && (
          <div style={{ display: 'grid', gap: 14 }}>
            <PoolChart snapshots={liveSnapshots} />
            <SnapshotTable snapshots={liveSnapshots} />
          </div>
        )}

        {activeTab === 'logs' && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div className="panel-header">Live Log Tail</div>
            <LogTail logs={liveLogs} />
          </div>
        )}

        {activeTab === 'system' && (
          <div style={{ display: 'grid', gap: 14, maxWidth: 600 }}>
            <div className="panel">
              <div className="panel-header">System Health</div>
              <div className="panel-body">
                <div className="small">Uptime: {fmtAgo(state?.startedAt)}</div>
                <div className="small">WebSocket: {connected ? <span className="green">connected</span> : <span className="red">disconnected</span>}</div>
                <div className="small">Last discovery cycle: {state?.lastDiscoveryAt ? fmtAgo(state.lastDiscoveryAt) : '—'}</div>
                <div className="small">Last screening cycle: {state?.lastScreeningAt ? fmtAgo(state.lastScreeningAt) : '—'}</div>
                <div className="small">Last snapshot cycle: {state?.lastSnapshotAt ? fmtAgo(state.lastSnapshotAt) : '—'}</div>
                <div className="small">Last ranking cycle: {state?.lastRankingAt ? fmtAgo(state.lastRankingAt) : '—'}</div>
              </div>
            </div>
            <RestartButton />
          </div>
        )}
      </main>
    </div>
  );
}
