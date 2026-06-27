'use client';
import { useEffect, useRef, useState, useCallback } from 'react';

export function useWebSocket(url) {
  const ws = useRef(null);
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);

  const send = useCallback((msg) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    let reconnectTimer;
    function connect() {
      const socket = new WebSocket(url);
      ws.current = socket;

      socket.onopen = () => {
        setConnected(true);
        send({ type: 'subscribe', channels: ['state', 'signals', 'snapshots', 'logs', 'cycles'] });
      };

      socket.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };

      socket.onerror = () => {
        socket.close();
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          setLastMessage(msg);
        } catch {}
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      ws.current?.close();
    };
  }, [url, send]);

  return { connected, lastMessage, send };
}
