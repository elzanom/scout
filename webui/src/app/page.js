'use client';
import { useState, useEffect, useMemo } from 'react';
import Image from 'next/image';
import { useApi } from '../hooks/useApi';
import { useWebSocket } from '../hooks/useWebSocket';
import TopStatusBar from '../components/TopStatusBar';
import StatCards, { CycleSummary } from '../components/StatCards';
import WalletTable from '../components/WalletTable';
import PositionTable from '../components/PositionTable';
import SignalTable from '../components/SignalTable';
import SnapshotTable from '../components/SnapshotTable';
import PoolChart from '../components/PoolChart';
import PoolList from '../components/PoolList';
import LogTail from '../components/LogTail';
import SystemPanel from '../components/SystemPanel';

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
  const { data: walletsData } = useApi('/api/wallets?limit=5000');
  const { data: positionsData } = useApi('/api/positions?limit=200');
  const { data: signalsData } = useApi('/api/signals?limit=100');
  const { data: snapshotsData } = useApi('/api/snapshots?limit=200');
  const { data: poolsData } = useApi('/api/pools');
  const { data: logsData } = useApi('/api/logs?lines=100');
  const { data: configData } = useApi('/api/config');

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

  const topWallets = useMemo(() =>
    walletsData?.wallets?.filter((w) => w.is_top_wallet).slice(0, 8) || [],
    [walletsData],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="app-logo">
            <Image src="/of.png" alt="Laminar Scout" width={52} height={52} priority />
          </div>
          <div>
            <div className="app-title">Laminar Scout</div>
            <div className="app-subtitle">Self-discovering LP wallet tracker for Meteora DLMM</div>
          </div>
        </div>
        <TopStatusBar state={liveState} connected={connected} />
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
          <div style={{ display: 'grid', gap: 16 }}>
            <StatCards state={liveState} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
              <CycleSummary state={liveState} />
              <div className="panel">
                <div className="panel-header">Top Wallets</div>
                <div className="panel-body">
                  {topWallets.length ? (
                    <div className="top-wallet-list">
                      {topWallets.map((w) => (
                        <div key={w.address} className="top-wallet-row">
                          <span className="mono address-text">{w.address.slice(0, 12)}…{w.address.slice(-6)}</span>
                          <span className="cyan" style={{ fontWeight: 700 }}>{w.score?.toFixed?.(1)}</span>
                          <span className="small">{(w.win_rate * 100).toFixed?.(0)}% WR</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="small dim">No top wallets yet</div>
                  )}
                </div>
              </div>
            </div>
            <div className="panel">
              <div className="panel-header">Recent Signals</div>
              <SignalTable signals={liveSignals?.slice(0, 8)} />
            </div>
          </div>
        )}

        {activeTab === 'wallets' && (
          <WalletTable wallets={walletsData?.wallets} />
        )}

        {activeTab === 'positions' && (
          <PositionTable positions={positionsData?.positions} />
        )}

        {activeTab === 'signals' && (
          <SignalTable signals={liveSignals} />
        )}

        {activeTab === 'pools' && (
          <div style={{ display: 'grid', gap: 14 }}>
            <PoolChart snapshots={liveSnapshots} />
            <PoolList pools={poolsData?.pools} />
            <SnapshotTable snapshots={liveSnapshots} />
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="panel">
            <div className="panel-header">Live Log Tail</div>
            <LogTail logs={liveLogs} />
          </div>
        )}

        {activeTab === 'system' && (
          <SystemPanel state={liveState} config={configData} />
        )}
      </main>
    </div>
  );
}
