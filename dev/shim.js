'use strict';
// Stands in for the `window.blink` object Wink injects. Loaded only by
// dev/mock-host.mjs. Native dialogs become prompt(); set window.__mockURL to
// answer the URL prompt from automation.
(() => {
  const call = async (method, args = {}) => {
    const response = await fetch('/bridge', { method: 'POST', body: JSON.stringify({ method, args }) });
    const reply = await response.json();
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  const askURL = text => {
    const url = window.__mockURL ?? prompt(text, 'mysql://user:password@127.0.0.1:3306/database');
    window.__mockURL = undefined;
    return url;
  };
  window.blink = Object.freeze({
    apiVersion: 1,
    host: { info: async () => ({ apiVersion: 1, host: 'dev', platform: 'web', capabilities: ['host.info', 'database', 'storage.get', 'storage.set'] }) },
    database: {
      connect: () => call('connect'),
      connections: () => call('connections'),
      sshHosts: () => call('sshHosts'),
      edit: id => { const url = askURL('Connection URL (development host)'); return url ? call('edit', { id, url }) : Promise.resolve(null); },
      importURL: () => { const url = askURL('Paste a connection URL'); return url ? call('importURL', { url }) : Promise.resolve(null); },
      duplicate: id => call('duplicate', { id }),
      remove: id => confirm('Delete this connection?') ? call('remove', { id }) : Promise.resolve(false),
      copyURL: async id => { console.log('URL:', await call('copyURL', { id })); return true; },
      open: id => call('open', { id }),
      status: () => call('status'),
      disconnect: () => call('disconnect'),
      query: (sql, options = {}) => call('query', { ...options, sql }),
      execute: statements => call('execute', { statements }),
      cancel: () => call('cancel'),
    },
    storage: {
      get: async key => localStorage.getItem('dev.' + key),
      set: async (key, value) => { localStorage.setItem('dev.' + key, value); return true; },
    },
  });
})();
