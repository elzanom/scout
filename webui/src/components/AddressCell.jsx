'use client';
import { useState } from 'react';
import { shorten } from '../lib/format';

const METEORA_POOL_URL = 'https://app.meteora.ag/dlmm/';

export default function AddressCell({ address, type = 'wallet', head = 6, tail = 4, showCopy = true, showLink = false }) {
  const [copied, setCopied] = useState(false);
  if (!address) return <span className="dim">—</span>;

  const isPool = type === 'pool';
  const href = isPool ? `${METEORA_POOL_URL}${address}` : `https://solscan.io/account/${address}`;

  const handleCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <span className="address-cell mono" title={address}>
      {(showLink || isPool) ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="address-link"
          onClick={(e) => !isPool && showLink ? undefined : e.stopPropagation()}
        >
          {shorten(address, head, tail)}
        </a>
      ) : (
        <span className="address-text">{shorten(address, head, tail)}</span>
      )}
      {showCopy && (
        <button
          type="button"
          className="copy-btn"
          onClick={handleCopy}
          title="Copy address"
          aria-label="Copy address"
        >
          {copied ? '✓' : '📋'}
        </button>
      )}
    </span>
  );
}
