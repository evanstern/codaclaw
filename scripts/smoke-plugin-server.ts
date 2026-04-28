/**
 * Plugin IPC end-to-end smoke — Card #2 (Card A) done-when verifier.
 *
 * Drives a full start -> deliver -> output round-trip through the
 * plugin socket. Equivalent in scope to validate-165, but exercises
 * the IPC surface instead of importing internal modules directly.
 *
 * Run while `pnpm run dev` is live in another shell:
 *   pnpm exec tsx scripts/smoke-plugin-server.ts
 *
 * Cleanup between runs (mirrors validate-165):
 *   rm -rf groups/smoke-plugin data/v2-sessions/smoke-plugin
 *   sqlite3 data/v2.db "DELETE FROM agent_groups WHERE id='smoke-plugin';"
 *
 * Exits 0 on a chat response landing in output(), 1 on timeout.
 */
import net from 'net';
import os from 'os';
import path from 'path';

const SLUG = 'smoke-plugin';
const SOCKET_PATH = process.env.PLUGIN_SOCKET_PATH || path.join(os.homedir(), '.codaclaw', 'host.sock');
const TIMEOUT_MS = 90_000;

interface OutputMessage {
  id: string;
  timestamp: string;
  type: string;
  body: string;
}

async function rpc(req: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (c: string) => {
      buf += c;
    });
    sock.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log(`[smoke] socket: ${SOCKET_PATH}`);

  console.log('[smoke] start');
  const startResp = await rpc({ op: 'start', agent: SLUG });
  if (!startResp.ok) {
    console.error('[smoke] start failed:', startResp);
    process.exit(1);
  }
  const sessionId = startResp.session_id as string;
  console.log(`[smoke] session ${sessionId}`);

  console.log('[smoke] health (immediate)');
  console.log('[smoke]', await rpc({ op: 'health', session_id: sessionId }));

  const messageId = `msg-smoke-${Date.now()}`;
  console.log(`[smoke] deliver ${messageId}`);
  const deliverResp = await rpc({
    op: 'deliver',
    session_id: sessionId,
    message: {
      id: messageId,
      from: 'smoke-test',
      type: 'note',
      body: 'Reply with exactly one word: PONG',
    },
  });
  if (!deliverResp.ok || !deliverResp.delivered) {
    console.error('[smoke] deliver failed:', deliverResp);
    process.exit(1);
  }

  console.log('[smoke] polling output for chat response (90s timeout)');
  const deadline = Date.now() + TIMEOUT_MS;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const out = await rpc({ op: 'output', session_id: sessionId });
    if (!out.ok) {
      console.error('[smoke] output failed:', out);
      process.exit(1);
    }
    const messages = (out.messages ?? []) as OutputMessage[];
    if (messages.length !== lastCount) {
      console.log(`[smoke] output rows: ${messages.length}`);
      lastCount = messages.length;
    }
    const chat = messages.find((m) => m.type === 'chat');
    if (chat) {
      console.log('\n=== RESPONSE ===');
      console.log(chat.body);
      console.log('================\n');

      console.log('[smoke] health (final)');
      console.log('[smoke]', await rpc({ op: 'health', session_id: sessionId }));

      console.log('[smoke] stop');
      console.log('[smoke]', await rpc({ op: 'stop', session_id: sessionId }));

      console.log(`[smoke] SUCCESS — round-trip in ${Math.round((TIMEOUT_MS - (deadline - Date.now())) / 1000)}s`);
      process.exit(0);
    }
    await sleep(2000);
  }

  console.error('[smoke] TIMEOUT — no chat response in output() after 90s');
  console.error('[smoke] check `pnpm run dev` host logs and `docker ps`');
  process.exit(1);
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(2);
});
