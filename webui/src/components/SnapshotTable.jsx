'use client';
import { fmtUsd, fmtNumber, fmtPct, fmtDate } from '../lib/format';
import AddressCell from './AddressCell';
import SearchFilter from './SearchFilter';

export default function SnapshotTable({ snapshots }) {
  if (!snapshots?.length) return <div className="panel panel-body">No snapshots</div>;

  const keys = ['pool_address'];

  return (
    <SearchFilter items={snapshots} keys={keys}>
      {(filtered, query, setQuery) => (
        <div className="table-wrap panel">
          <div className="panel-header" style={{ justifyContent: 'flex-start', gap: 12 }}>
            <span>{filtered.length} snapshot{filtered.length !== 1 ? 's' : ''}</span>
            <input
              type="text"
              placeholder="Search snapshots…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ minWidth: 180 }}
            />
            {query && (
              <button className="secondary" onClick={() => setQuery('')}>Clear</button>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Pool</th>
                <th className="num">Fee APR</th>
                <th className="num">Volume 24h</th>
                <th className="num">TVL</th>
                <th className="num">Buy/Sell</th>
                <th className="num">Vol Δ 1h</th>
                <th className="num">Swap Δ 1h</th>
                <th className="num">Creator %</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.id}>
                  <td className="dim">{i + 1}</td>
                  <td className="small">{fmtDate(s.timestamp)}</td>
                  <td><AddressCell address={s.pool_address} type="pool" head={8} tail={4} /></td>
                  <td className={`num ${(s.fee_apr ?? 0) > 1 ? 'green' : ''}`}>{fmtPct(s.fee_apr)}</td>
                  <td className="num">{fmtUsd(s.volume_24h)}</td>
                  <td className="num">{fmtUsd(s.tvl)}</td>
                  <td className={`num ${(s.buy_sell_ratio_24h ?? 0) >= 1 ? 'green' : 'red'}`}>{fmtNumber(s.buy_sell_ratio_24h, 2)}</td>
                  <td className={`num ${(s.volume_change_pct_1h ?? 0) >= 0 ? 'green' : 'red'}`}>{fmtPct(s.volume_change_pct_1h)}</td>
                  <td className={`num ${(s.swap_count_change_pct_1h ?? 0) >= 0 ? 'green' : 'red'}`}>{fmtPct(s.swap_count_change_pct_1h)}</td>
                  <td className="num">{fmtPct(s.creator_holding_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SearchFilter>
  );
}
