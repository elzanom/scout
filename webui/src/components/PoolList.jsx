'use client';
import { fmtUsd, fmtNumber, fmtPct, fmtDate } from '../lib/format';
import AddressCell from './AddressCell';
import SearchFilter from './SearchFilter';

export default function PoolList({ pools }) {
  if (!pools?.length) return <div className="panel panel-body">No pools with snapshots yet</div>;

  const keys = ['pool_address', 'latest.token_pair'];

  return (
    <SearchFilter items={pools} keys={keys}>
      {(filtered, query, setQuery) => (
        <div className="table-wrap panel">
          <div className="panel-header" style={{ justifyContent: 'flex-start', gap: 12 }}>
            <span>{filtered.length} pool{filtered.length !== 1 ? 's' : ''}</span>
            <input
              type="text"
              placeholder="Search pools…"
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
                <th>Pool</th>
                <th>Pair</th>
                <th className="num">Latest</th>
                <th className="num">Snapshots</th>
                <th className="num">Fee APR</th>
                <th className="num">Fee/TVL</th>
                <th className="num">Volume 24h</th>
                <th className="num">TVL</th>
                <th className="num">Organic</th>
                <th className="num">Volatility</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const l = p.latest || {};
                return (
                  <tr key={p.pool_address}>
                    <td className="dim">{i + 1}</td>
                    <td><AddressCell address={p.pool_address} type="pool" head={8} tail={4} /></td>
                    <td>{l.token_pair || '—'}</td>
                    <td className="small">{fmtDate(p.latest_at)}</td>
                    <td className="num">{fmtNumber(p.snapshot_count, 0)}</td>
                    <td className={`num ${(l.fee_apr ?? 0) > 1 ? 'green' : ''}`}>{fmtPct(l.fee_apr)}</td>
                    <td className="num">{fmtPct((l.fee_tvl_ratio ?? 0) / 100)}</td>
                    <td className="num">{fmtUsd(l.volume_24h)}</td>
                    <td className="num">{fmtUsd(l.tvl)}</td>
                    <td className={`num ${(l.base_organic_score ?? 0) >= 60 ? 'green' : 'yellow'}`}>{fmtNumber(l.base_organic_score, 0)}</td>
                    <td className="num">{fmtNumber(l.token_volatility_24h, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SearchFilter>
  );
}
