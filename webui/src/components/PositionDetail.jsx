'use client';
import { useApi } from '../hooks/useApi';
import { fmtUsd, fmtNumber, fmtDate } from '../lib/format';
import AddressCell from './AddressCell';

const EV_LABEL = { add: 'Deposit', remove: 'Withdraw', claim_fee: 'Claim Fee' };
const EV_EMOJI = { add: '⬇️', remove: '⬆️', claim_fee: '🪙' };

// position_events.block_time is in milliseconds; fmtDate expects seconds.
const fmtMs = (ts) => (ts ? fmtDate(Math.floor(ts / 1000)) : '—');

function Card({ label, value, className }) {
  return (
    <div className="panel" style={{ padding: 10, margin: 0 }}>
      <div className="small dim">{label}</div>
      <div className={className} style={{ fontWeight: 700, fontSize: 16 }}>{value}</div>
    </div>
  );
}

function fmtPrice(p) {
  if (p == null) return "—";
  if (p >= 1) return p.toFixed(4);
  if (p >= 1e-4) return p.toFixed(6);
  return p.toExponential(2);
}

/** Metlex-style bin distribution strip: in-range bins cyan, active bin green, out-of-range dim. */
function BinDistribution({ dist }) {
  const { bins, activeBinId, activePrice, ratio } = dist;
  if (!bins?.length) return null;
  const low = bins[0].price;
  const high = bins[bins.length - 1].price;
  const bps = ratio && ratio > 1 ? `${((ratio - 1) * 10000).toFixed(0)} bps` : "?";
  return (
    <div className="panel" style={{ padding: 10, margin: 0, marginBottom: 12 }}>
      <div className="small dim" style={{ marginBottom: 6 }}>
        Bin distribution · {bins.length} bins · step {bps}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", height: 44, gap: 1, marginBottom: 6 }}>
        {bins.map((b) => (
          <div
            key={b.binId}
            title={`bin ${b.binId} · ${fmtPrice(b.price)}${b.isActive ? " (active)" : b.inRange ? "" : " (out of range)"}`}
            style={{
              flex: 1,
              minWidth: 2,
              height: b.isActive ? "100%" : b.inRange ? "72%" : "22%",
              background: b.isActive ? "#39ff14" : b.inRange ? "#00e5ff" : "rgba(255,255,255,0.12)",
              borderRadius: 1,
            }}
          />
        ))}
      </div>
      <div className="dim" style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
        <span>{fmtPrice(low)}</span>
        <span>active {fmtPrice(activePrice)} · bin {activeBinId ?? "?"}</span>
        <span>{fmtPrice(high)}</span>
      </div>
    </div>
  );
}

/** Metlex-style position detail: PnL ledger + on-chain bin range, from /api/position/:addr?decode=1. */
export default function PositionDetail({ positionId, onClose }) {
  const { data, loading, error } = useApi(
    `/api/position/${encodeURIComponent(positionId)}?decode=1`,
  );

  const position = data?.position;
  const events = data?.events || [];
  const summary = data?.summary || {};
  const decoded = data?.decoded;

  // Prefer on-chain decoded range; fall back to the positions row (from /positions/{pool}/pnl).
  const binRange = decoded?.binRange ||
    (position?.bin_lower != null && position?.bin_upper != null
      ? { lowerBinId: position.bin_lower, upperBinId: position.bin_upper, source: 'positions' }
      : null);

  const positive = (summary.pnl_usd ?? 0) >= 0;

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="panel-header" style={{ justifyContent: 'space-between' }}>
        <span>
          📍 Position detail{' '}
          <code className="mono small">
            {positionId.slice(0, 8)}…{positionId.slice(-4)}
          </code>
        </span>
        <button className="secondary" onClick={onClose}>Close ✕</button>
      </div>

      <div className="panel-body">
        {loading && <div className="small dim">Loading (syncing Meteora + decoding on-chain)…</div>}
        {error && <div className="small red">Error: {error}</div>}

        {data && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              {position?.status && <span className={`badge badge-${position.status}`}>{position.status}</span>}
              {position?.token_pair && <span className="cyan"><b>{position.token_pair}</b></span>}
              {binRange && (
                <span className="small">
                  Bin range:{' '}
                  <b>{binRange.lowerBinId}…{binRange.upperBinId == null ? '?' : binRange.upperBinId}</b>
                  {binRange.upperBinId != null && (
                    <span className="dim"> (width {binRange.upperBinId - binRange.lowerBinId + 1})</span>
                  )}
                  <span className="dim"> · src {binRange.source}</span>
                </span>
              )}
              {position?.pool_address && (
                <span className="small dim">pool <AddressCell address={position.pool_address} type="pool" head={6} tail={4} /></span>
              )}
            </div>

            {decoded?.binDistribution && <BinDistribution dist={decoded.binDistribution} />}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 12 }}>
              <Card label="Deposit" value={fmtUsd(summary.total_deposit_usd)} />
              <Card label="Withdraw" value={fmtUsd(summary.total_withdraw_usd)} />
              <Card label="Fees" value={fmtUsd(summary.total_fees_usd)} />
              <Card label="PnL" value={fmtUsd(summary.pnl_usd)} className={positive ? 'green' : 'red'} />
              <Card
                label="PnL %"
                value={summary.pnl_pct != null ? `${summary.pnl_pct.toFixed(2)}%` : '—'}
                className={positive ? 'green' : 'red'}
              />
              <Card
                label="Duration"
                value={summary.duration_ms != null ? `${fmtNumber(summary.duration_ms / 3_600_000, 1)}h` : '—'}
              />
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th className="num">Amount X USD</th>
                    <th className="num">Amount Y USD</th>
                    <th className="num">Total USD</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 && (
                    <tr><td colSpan={5} className="dim small">No events synced</td></tr>
                  )}
                  {events.map((e, i) => (
                    <tr key={i}>
                      <td className="small">{fmtMs(e.block_time)}</td>
                      <td>{EV_EMOJI[e.event_type] || '•'} {EV_LABEL[e.event_type] || e.event_type}</td>
                      <td className="num">{fmtUsd(e.amount_x_usd)}</td>
                      <td className="num">{fmtUsd(e.amount_y_usd)}</td>
                      <td className="num">{fmtUsd(e.total_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {decoded?.error && <div className="small red" style={{ marginTop: 8 }}>decode: {decoded.error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
