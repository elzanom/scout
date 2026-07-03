'use client';
import { useApi } from '../hooks/useApi';
import { fmtUsd, fmtNumber, fmtDate, fmtPct, shorten } from '../lib/format';
import AddressCell from './AddressCell';

function Card({ label, value, className }) {
  return (
    <div className="panel" style={{ padding: 10, margin: 0 }}>
      <div className="small dim">{label}</div>
      <div className={className} style={{ fontWeight: 700, fontSize: 16 }}>{value}</div>
    </div>
  );
}

function Tags({ tagsJson }) {
  let tags = [];
  try { tags = JSON.parse(tagsJson) || []; } catch { tags = []; }
  if (!Array.isArray(tags) || !tags.length) return <span className="dim small">no tags</span>;
  return (
    <span>
      {tags.map((t) => (
        <span key={t} className="badge" style={{ marginRight: 4, background: "rgba(0,229,255,0.15)", color: "#00e5ff" }}>{t}</span>
      ))}
    </span>
  );
}

export default function WalletDetail({ walletAddress, onClose }) {
  const { data, loading, error } = useApi(`/api/wallets/${encodeURIComponent(walletAddress)}`);
  const w = data?.wallet || {};
  const positions = data?.positions || [];
  const signals = data?.signals || [];
  const discovery = data?.discovery_log || [];

  const positive = (w.total_pnl_usd ?? 0) >= 0;
  const decided = w.win_count + w.loss_count;

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="panel-header" style={{ justifyContent: 'space-between' }}>
        <span>
          👛 Wallet detail{' '}
          <code className="mono small">{shorten(walletAddress, 8, 4)}</code>
          {w.is_top_wallet ? <span className="badge" style={{ marginLeft: 8 }}>⭐ top</span> : null}
        </span>
        <button className="secondary" onClick={onClose}>Close ✕</button>
      </div>

      <div className="panel-body">
        {loading && <div className="small dim">Loading…</div>}
        {error && <div className="small red">Error: {error}</div>}

        {data && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <span className={`badge badge-${w.status}`}>{w.status}</span>
              {w.alias && <span className="cyan"><b>{w.alias}</b></span>}
              <span className="small">strategy <b>{w.preferred_strategy || '—'}</b>{w.preferred_range_style ? ` / ${w.preferred_range_style}` : ''}</span>
              <span className="small dim">evals {w.evaluation_count ?? 0} · last {fmtDate(w.last_evaluated)}</span>
              {w.reject_reason && <span className="small red">{w.reject_reason}</span>}
            </div>

            <div style={{ marginBottom: 10 }}><Tags tagsJson={w.tags} /></div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10, marginBottom: 12 }}>
              <Card label="Score" value={fmtNumber(w.score, 1)} className="cyan" />
              <Card label="Win rate" value={`${fmtPct(w.win_rate, 0)} (${w.win_count ?? 0}W/${w.loss_count ?? 0}L)`} className={decided ? '' : 'dim'} />
              <Card label="PNL" value={fmtUsd(w.total_pnl_usd)} className={positive ? 'green' : 'red'} />
              <Card label="Positions" value={fmtNumber(w.total_positions, 0)} />
              <Card label="Fees" value={fmtUsd(w.total_fees_usd)} />
              <Card label="Fee yield" value={fmtNumber(w.avg_fee_yield, 2)} />
            </div>

            <div className="panel-header" style={{ justifyContent: 'flex-start', gap: 8 }}>
              <span>Positions ({positions.length})</span>
              <span className="small dim">· click in the Positions tab for per-position PnL + bin detail</span>
            </div>
            <div className="table-wrap" style={{ marginBottom: 12 }}>
              <table>
                <thead><tr><th>Pair</th><th>Status</th><th className="num">Capital</th><th className="num">PNL</th><th className="num">Fees</th><th>Entry</th></tr></thead>
                <tbody>
                  {positions.length === 0 && <tr><td colSpan={6} className="dim small">No positions</td></tr>}
                  {positions.slice(0, 20).map((p) => (
                    <tr key={p.id}>
                      <td>{p.token_pair || '—'}</td>
                      <td><span className={`badge badge-${p.status}`}>{p.status}</span></td>
                      <td className="num">{fmtUsd(p.capital_usd)}</td>
                      <td className={`num ${(p.pnl_usd ?? 0) >= 0 ? 'green' : 'red'}`}>{fmtUsd(p.pnl_usd)}</td>
                      <td className="num">{fmtUsd(p.fees_earned_usd)}</td>
                      <td className="small">{fmtDate(p.entry_timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="panel-header" style={{ justifyContent: 'flex-start', gap: 8 }}>
              <span>Recent signals ({signals.length})</span>
            </div>
            <div className="table-wrap" style={{ marginBottom: 12 }}>
              <table>
                <thead><tr><th>Pair</th><th className="num">Conf</th><th>Status</th><th>Time</th></tr></thead>
                <tbody>
                  {signals.length === 0 && <tr><td colSpan={4} className="dim small">No signals from this wallet</td></tr>}
                  {signals.map((s, i) => (
                    <tr key={i}>
                      <td>{s.token_pair || '—'}</td>
                      <td className="num">{s.combined_confidence?.toFixed?.(2) ?? '—'}</td>
                      <td>{s.status}</td>
                      <td className="small">{fmtDate(s.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {discovery.length > 0 && (
              <>
                <div className="panel-header" style={{ justifyContent: 'flex-start' }}><span>Discovery log</span></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Source</th><th>From</th><th>When</th></tr></thead>
                    <tbody>
                      {discovery.slice(0, 10).map((d, i) => (
                        <tr key={i}>
                          <td>{d.discovery_source}</td>
                          <td className="small mono">{d.source_detail ? shorten(d.source_detail, 8, 4) : '—'}</td>
                          <td className="small">{fmtDate(d.discovered_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
