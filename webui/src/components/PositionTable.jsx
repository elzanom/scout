'use client';
import { useState } from 'react';
import { fmtUsd, fmtNumber, fmtDate } from '../lib/format';
import AddressCell from './AddressCell';
import SearchFilter from './SearchFilter';
import PositionDetail from './PositionDetail';

export default function PositionTable({ positions }) {
  const [selected, setSelected] = useState(null);
  if (!positions?.length) return <div className="panel panel-body">No positions</div>;

  const keys = ['id', 'wallet_address', 'pool_address', 'token_pair', 'status'];

  return (
    <>
      <SearchFilter items={positions} keys={keys}>
        {(filtered, query, setQuery) => (
          <div className="table-wrap panel">
            <div className="panel-header" style={{ justifyContent: 'flex-start', gap: 12 }}>
              <span>{filtered.length} position{filtered.length !== 1 ? 's' : ''}</span>
              <input
                type="text"
                placeholder="Search positions…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ minWidth: 180 }}
              />
              {query && (
                <button className="secondary" onClick={() => setQuery('')}>Clear</button>
              )}
              <span className="small dim">· click a row for PnL + bin detail</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Wallet</th>
                  <th>Pool</th>
                  <th>Pair</th>
                  <th>Status</th>
                  <th className="num">Capital</th>
                  <th className="num">PNL</th>
                  <th className="num">PNL%</th>
                  <th className="num">Fees</th>
                  <th className="num">Yield</th>
                  <th className="num">Duration h</th>
                  <th>Entry</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, i) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelected(p.id)}
                    style={{
                      cursor: 'pointer',
                      background: selected === p.id ? 'rgba(0,229,255,0.08)' : undefined,
                    }}
                  >
                    <td className="dim">{i + 1}</td>
                    <td><AddressCell address={p.wallet_address} type="wallet" head={8} tail={4} showLink={false} /></td>
                    <td><AddressCell address={p.pool_address} type="pool" head={8} tail={4} /></td>
                    <td>{p.token_pair || '—'}</td>
                    <td><span className={`badge badge-${p.status}`}>{p.status}</span></td>
                    <td className="num">{fmtUsd(p.capital_usd)}</td>
                    <td className={`num ${(p.pnl_usd ?? 0) >= 0 ? 'green' : 'red'}`}>{fmtUsd(p.pnl_usd)}</td>
                    <td className={`num ${(p.pnl_pct ?? 0) >= 0 ? 'green' : 'red'}`}>{fmtNumber(p.pnl_pct, 1)}%</td>
                    <td className="num">{fmtUsd(p.fees_earned_usd)}</td>
                    <td className="num">{fmtNumber(p.fee_yield, 2)}</td>
                    <td className="num">{fmtNumber(p.duration_hours, 1)}</td>
                    <td className="small">{fmtDate(p.entry_timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SearchFilter>
      {selected && <PositionDetail positionId={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
