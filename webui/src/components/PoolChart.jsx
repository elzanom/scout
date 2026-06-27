'use client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { fmtDate } from '../lib/format';

export default function PoolChart({ snapshots }) {
  if (!snapshots?.length) return <div className="panel panel-body">Select a pool with snapshots to view chart</div>;

  const data = [...snapshots]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((s) => ({
      time: fmtDate(s.timestamp),
      feeApr: s.fee_apr ?? 0,
      volume: s.volume_24h ?? 0,
      tvl: s.tvl ?? 0,
    }));

  return (
    <div className="panel">
      <div className="panel-body">
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 11 }}>
          <div><span className="small">Fee APR</span><div style={{ color: 'var(--accent)', fontWeight: 700 }}>cyan line</div></div>
          <div><span className="small">Volume 24h</span><div style={{ color: 'var(--accent-3)', fontWeight: 700 }}>blue line</div></div>
        </div>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} angle={-20} textAnchor="end" height={50} />
              <YAxis yAxisId="left" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
              <Tooltip contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', color: 'var(--text)' }} />
              <Line yAxisId="left" type="monotone" dataKey="feeApr" stroke="var(--accent)" dot={false} strokeWidth={2} />
              <Line yAxisId="right" type="monotone" dataKey="volume" stroke="var(--accent-3)" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
