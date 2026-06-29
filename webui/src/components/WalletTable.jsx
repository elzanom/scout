'use client';
import { useState, useMemo, useEffect } from 'react';
import { fmtNumber, fmtPct, fmtUsd } from '../lib/format';
import AddressCell from './AddressCell';
import SearchFilter from './SearchFilter';

const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'top', label: 'Top' },
  { key: 'tracked', label: 'Tracked' },
  { key: 'candidate', label: 'Candidates' },
  { key: 'rejected', label: 'Rejected' },
];

const PAGE_SIZES = [25, 50, 100, 200];

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
  const [statusTab, setStatusTab] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' });

  if (!wallets?.length) return <div className="panel panel-body">No wallets</div>;

  const filteredByStatus = useMemo(() => {
    if (statusTab === 'all') return wallets;
    if (statusTab === 'top') return wallets.filter((w) => w.is_top_wallet);
    return wallets.filter((w) => w.status === statusTab);
  }, [wallets, statusTab]);

  const counts = useMemo(() => ({
    all: wallets.length,
    top: wallets.filter((w) => w.is_top_wallet).length,
    tracked: wallets.filter((w) => w.status === 'tracked').length,
    candidate: wallets.filter((w) => w.status === 'candidate').length,
    rejected: wallets.filter((w) => w.status === 'rejected').length,
  }), [wallets]);

  const keys = ['address', 'status', 'preferred_strategy', 'preferred_range_style', 'tags'];

  const sortable = useMemo(() => ({
    score: (a, b) => (a.score ?? 0) - (b.score ?? 0),
    win_rate: (a, b) => (a.win_rate ?? 0) - (b.win_rate ?? 0),
    total_pnl_usd: (a, b) => (a.total_pnl_usd ?? 0) - (b.total_pnl_usd ?? 0),
    total_fees_usd: (a, b) => (a.total_fees_usd ?? 0) - (b.total_fees_usd ?? 0),
    total_positions: (a, b) => (a.total_positions ?? 0) - (b.total_positions ?? 0),
    pool_count: (a, b) => (a.pool_count ?? 0) - (b.pool_count ?? 0),
    open_positions: (a, b) => (a.open_positions ?? 0) - (b.open_positions ?? 0),
    win_count: (a, b) => (a.win_count ?? 0) - (b.win_count ?? 0),
    loss_count: (a, b) => (a.loss_count ?? 0) - (b.loss_count ?? 0),
    status: (a, b) => (a.status || '').localeCompare(b.status || ''),
    preferred_strategy: (a, b) => (a.preferred_strategy || '').localeCompare(b.preferred_strategy || ''),
    preferred_range_style: (a, b) => (a.preferred_range_style || '').localeCompare(b.preferred_range_style || ''),
    address: (a, b) => (a.address || '').localeCompare(b.address || ''),
  }), []);

  const sorted = useMemo(() => {
    const cmp = sortable[sort.key];
    if (!cmp) return filteredByStatus;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filteredByStatus].sort((a, b) => dir * cmp(a, b));
  }, [filteredByStatus, sort, sortable]);

  // Reset pagination when tab or page size changes.
  useEffect(() => {
    setPage(1);
  }, [statusTab, pageSize]);

  const toggleSort = (key) => {
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  };

  const sortIndicator = (key) => {
    if (sort.key !== key) return <span className="dim">⇅</span>;
    return sort.dir === 'desc' ? '↓' : '↑';
  };

  return (
    <SearchFilter items={sorted} keys={keys}>
      {(filtered, query, setQuery) => {
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * pageSize;
        const paged = filtered.slice(start, start + pageSize);

        // Reset to page 1 when search query changes.
        useEffect(() => {
          setPage(1);
        }, [query]);

        return (
          <div className="table-wrap panel">
            <div className="panel-header" style={{ justifyContent: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              {STATUS_TABS.map((t) => (
                <button
                  key={t.key}
                  className={statusTab === t.key ? 'primary' : 'secondary'}
                  onClick={() => setStatusTab(t.key)}
                >
                  {t.label} ({counts[t.key] ?? 0})
                </button>
              ))}
              <span style={{ marginLeft: 'auto' }}>{total} wallet{total !== 1 ? 's' : ''}</span>
              <input
                type="text"
                placeholder="Search wallets…"
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
                  <th onClick={() => toggleSort('address')} style={{ cursor: 'pointer' }}>Wallet {sortIndicator('address')}</th>
                  <th onClick={() => toggleSort('status')} style={{ cursor: 'pointer' }}>Status {sortIndicator('status')}</th>
                  <th className="num" onClick={() => toggleSort('score')} style={{ cursor: 'pointer' }}>Score {sortIndicator('score')}</th>
                  <th className="num" onClick={() => toggleSort('win_rate')} style={{ cursor: 'pointer' }}>WR% {sortIndicator('win_rate')}</th>
                  <th className="num" onClick={() => toggleSort('total_pnl_usd')} style={{ cursor: 'pointer' }}>PNL USD {sortIndicator('total_pnl_usd')}</th>
                  <th className="num" onClick={() => toggleSort('total_fees_usd')} style={{ cursor: 'pointer' }}>Fees {sortIndicator('total_fees_usd')}</th>
                  <th className="num" onClick={() => toggleSort('total_positions')} style={{ cursor: 'pointer' }}>Pos {sortIndicator('total_positions')}</th>
                  <th className="num" onClick={() => toggleSort('pool_count')} style={{ cursor: 'pointer' }}>Pools {sortIndicator('pool_count')}</th>
                  <th className="num" onClick={() => toggleSort('open_positions')} style={{ cursor: 'pointer' }}>Open {sortIndicator('open_positions')}</th>
                  <th className="num" onClick={() => toggleSort('win_count')} style={{ cursor: 'pointer' }}>W/L {sortIndicator('win_count')}</th>
                  <th onClick={() => toggleSort('preferred_strategy')} style={{ cursor: 'pointer' }}>Strategy {sortIndicator('preferred_strategy')}</th>
                  <th onClick={() => toggleSort('preferred_range_style')} style={{ cursor: 'pointer' }}>Range {sortIndicator('preferred_range_style')}</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((w, i) => (
                  <tr key={w.address}>
                    <td className="dim">{start + i + 1}</td>
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
            <div className="panel-header" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>← Prev</button>
                <span>Page {safePage} of {totalPages}</span>
                <button className="secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>Next →</button>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="dim">Rows per page</span>
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                  {PAGE_SIZES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        );
      }}
    </SearchFilter>
  );
}
