'use client';
import { useState, useMemo } from 'react';

export default function SearchFilter({ items, keys, children }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return items || [];
    const q = query.toLowerCase();
    return (items || []).filter((item) =>
      keys.some((k) => {
        const v = k.split('.').reduce((obj, key) => obj?.[key], item);
        return String(v ?? '').toLowerCase().includes(q);
      })
    );
  }, [items, query, keys]);

  return (
    <div style={{ display: 'grid', gap: 0 }}>
      {children(filtered, query, setQuery)}
    </div>
  );
}
