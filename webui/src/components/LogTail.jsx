'use client';
import { useRef, useEffect } from 'react';

export default function LogTail({ logs }) {
  const bottom = useRef(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  if (!logs?.length) return <div className="panel panel-body">No logs</div>;

  return (
    <div className="panel" style={{ maxHeight: 320, overflow: 'auto' }}>
      <div className="panel-body">
        {logs.map((l, i) => (
          <div key={i} className="log-line">
            <span className="ts">{l.timestamp}</span>
            <span className={`level ${l.level}`}>[{l.level?.toUpperCase()}]</span>
            <span>{l.message}</span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}
