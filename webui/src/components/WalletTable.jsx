'use client';
import { fmtNumber, fmtPct, fmtUsd } from '../lib/format';
import AddressCell from './AddressCell';

function TagList({ tagsJson }) {
  if (!tagsJson) return <span className="dim">—</span>;
  let tags = [];
  try { tags = JSON.parse(tagsJson); } catch { return <span className="dim">—</span>; }
  if (!Array.isArray(tags) || !tags.length) return <span className="dim">—</span>;
  return (
    <div className="tag-list">
      {tags.slice(0, 3).map((t) => (
        <span key={t} className="badge badge-tag">{t}</span>
      ))}
      {tags.length > 3 && <span className="dim">+{tags.length - 3}</span>}
    </div>
  );
}

export default function WalletTable({ wallets }) {
  if (!wallets?.length) return <div className="panel panel-body">No wallets</div>;

  return (
    <div className="table-wrap panel">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Wallet</th>
            <th>Status</th>
            <th className="num">Score</th>
            <th className="num">WR%</th>
            <th className="num">PNL USD</th>
            <th className="num">Fees</th>
            <th className="num">Pos</th>
            <th className="num">Pools</th>
            <th className="num">Open</th>
            <th className="num">W/L</th>
            <th>Strategy</th>
            <th>Range</th>
            <th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((w, i) => (
            <tr key={w.address}>
              <td className="dim">{i + 1}</td>
              <td><AddressCell address={w.address} type="wallet" head={10} tail={6} showLink={false} /></td>
              <td><span className={`badge badge-${w.status}`}>{w.status}</span></td>
              <td className="num cyan">{fmtNumber(w.score, 1)}</td>
              <td className={`num ${(w.win_rate ?? 0) >= 0.6 ? 'green' : ''}`}>{fmtPct(w.win_rate)}</td>
              <td className={`num ${(w.total_pnl_usd ?? 0) >= 0 ? 'green' : 'red'}`}>{fmtUsd(w.total_pnl_usd)}</td>
              <td className="num">{fmtUsd(w.total_fees_usd)}</td>
              <td className="num">{fmtNumber(w.total_positions, 0)}</td>
              <td className="num">{fmtNumber(w.pool_count, 0)}</td>
              <td className="num">{fmtNumber(w.open_positions, 0)}</td>
              <td className="num">{w.win_count ?? 0}/{w.loss_count ?? 0}</td>
              <td>{w.preferred_strategy ? <span className="badge badge-tag">{w.preferred_strategy}</span> : <span className="dim">—</span>}</td>
              <td>{w.preferred_range_style ? <span className="badge badge-pink">{w.preferred_range_style}</span> : <span className="dim">—</span>}</td>
              <td><TagList tagsJson={w.tags} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
