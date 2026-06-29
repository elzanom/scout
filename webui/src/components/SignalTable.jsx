'use client';
import { fmtNumber, fmtUsd, fmtDate } from '../lib/format';
import AddressCell from './AddressCell';
import SearchFilter from './SearchFilter';

export default function SignalTable({ signals }) {
  if (!signals?.length) return <div className="panel panel-body">No signals</div>;

  const keys = ['id', 'token_pair', 'trigger_type', 'triggered_by', 'pool_address', 'status'];

  return (
    <SearchFilter items={signals} keys={keys}>
      {(filtered, query, setQuery) => (
        <div className="table-wrap panel">
          <div className="panel-header" style={{ justifyContent: 'flex-start', gap: 12 }}>
            <span>{filtered.length} signal{filtered.length !== 1 ? 's' : ''}</span>
            <input
              type="text"
              placeholder="Search signals…"
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
                <th>Pair</th>
                <th>Trigger</th>
                <th>Wallet</th>
                <th>Pool</th>
                <th className="num">Confidence</th>
                <th className="num">Pool Score</th>
                <th className="num">Wallet Score</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.id}>
                  <td className="dim">{i + 1}</td>
                  <td className="small">{fmtDate(s.created_at)}</td>
                  <td>{s.token_pair || '—'}</td>
                  <td className="small">{s.trigger_type}</td>
                  <td><AddressCell address={s.triggered_by} type="wallet" head={8} tail={4} showLink={false} /></td>
                  <td><AddressCell address={s.pool_address} type="pool" head={8} tail={4} /></td>
                  <td className={`num ${(s.combined_confidence ?? 0) >= 0.7 ? 'green' : 'yellow'}`}>{fmtNumber(s.combined_confidence, 2)}</td>
                  <td className="num">{fmtNumber(s.pool_score, 2)}</td>
                  <td className="num">{fmtNumber(s.wallet_score, 1)}</td>
                  <td><span className={`badge badge-${s.status}`}>{s.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SearchFilter>
  );
}
