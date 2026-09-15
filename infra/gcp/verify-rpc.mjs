// Verify credentials without printing endpoint URLs or provider error bodies.
const expectedChain = '0x14a34';

async function verifyWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let subscription;
    const timeout = setTimeout(() => finish(false), 25_000);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (ok) resolve();
      else reject(new Error('WebSocket verification failed'));
    }
    socket.addEventListener('error', () => finish(false));
    socket.addEventListener('close', () => { if (!settled) finish(false); });
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
    });
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.error) return finish(false);
        if (message.id === 1) {
          if (message.result !== expectedChain) return finish(false);
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }));
        } else if (message.id === 2) {
          if (typeof message.result !== 'string') return finish(false);
          subscription = message.result;
        } else if (message.method === 'eth_subscription' && subscription && message.params?.subscription === subscription) {
          if (!/^0x[0-9a-f]+$/i.test(message.params.result?.number ?? '')) return finish(false);
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_unsubscribe', params: [subscription] }));
        } else if (message.id === 3) {
          finish(message.result === true);
        }
      } catch { finish(false); }
    });
  });
}

try {
  const credentials = JSON.parse(process.env.RPC_BOOTSTRAP_CREDENTIALS ?? '');
  delete process.env.RPC_BOOTSTRAP_CREDENTIALS;
  const http = /^https:\/\/base-sepolia\.g\.alchemy\.com\/v2\/([A-Za-z0-9_-]{10,200})$/.exec(credentials.rpc_http_url);
  const ws = /^wss:\/\/base-sepolia\.g\.alchemy\.com\/v2\/([A-Za-z0-9_-]{10,200})$/.exec(credentials.rpc_ws_url);
  if (!http || !ws || http[1] !== ws[1]) throw new Error('Invalid endpoints');
  async function rpc(method, params = []) {
    const response = await fetch(credentials.rpc_http_url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('HTTP request failed');
    const result = await response.json();
    if (result.error || !Object.hasOwn(result, 'result')) throw new Error('RPC request failed');
    return result.result;
  }
  if (await rpc('eth_chainId') !== expectedChain) throw new Error('Wrong network');
  const block = BigInt(await rpc('eth_blockNumber'));
  const logs = await rpc('eth_getLogs', [{
    fromBlock: `0x${(block - 9n).toString(16)}`, toBlock: `0x${block.toString(16)}`,
    address: '0x0000000000000000000000000000000000000000',
  }]);
  if (!Array.isArray(logs)) throw new Error('Invalid log result');
  console.log('HTTP verified: Base Sepolia 84532; eth_getLogs works over a 10-block span.');
  await verifyWebSocket(credentials.rpc_ws_url);
  console.log('WebSocket verified: Base Sepolia 84532; live block received and subscription removed.');
} catch {
  console.error('RPC verification failed; endpoint URLs and provider response bodies withheld.');
  process.exitCode = 1;
}
