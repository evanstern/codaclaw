/**
 * Card #165 validation — end-to-end round-trip through the live host.
 *
 * Sequence (this script, run while `pnpm run dev` is live in another shell):
 *   1. Open the host's central DB.
 *   2. Create a one-off agent group (idempotent across re-runs).
 *   3. Resolve an agent-shared session (messaging_group_id=null is legal).
 *   4. Write a trigger=1 message into the session's inbound.db.
 *   5. Wake the container.
 *   6. Poll outbound.db for a response (90s timeout).
 *   7. Print the response text and exit 0, or TIMEOUT and exit 1.
 *
 * Proves #165's done-when list without touching the channel/router layer,
 * so no messaging_groups row or channel adapter is required.
 *
 * Why platformId + channelType are set on the inbound message:
 * poll-loop.ts's single-destination fallback (container/agent-runner/src/
 * poll-loop.ts:377) only writes to outbound.db when routing.channelType
 * and routing.platformId are non-null. Without destinations registered
 * and without a messaging group, those come from the inbound message's
 * own routing fields. A bare-substrate test without them silently drops
 * the response as scratchpad.
 *
 * Cleanup between runs:
 *   rm -rf groups/validate-165 data/v2-sessions/ag-validate-165
 *   sqlite3 data/v2.db "DELETE FROM agent_groups WHERE id='ag-validate-165';"
 */

import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { createAgentGroup, getAgentGroup } from '../src/db/agent-groups.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { resolveSession, writeSessionMessage, openOutboundDb } from '../src/session-manager.js';
import { wakeContainer } from '../src/container-runner.js';
import type { AgentGroup } from '../src/types.js';

const AGENT_ID = 'ag-validate-165';
const AGENT_FOLDER = 'validate-165';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  // Connect to the SAME central DB the live host is using. Both processes
  // share data/v2.db because both are rooted at the repo cwd.
  initDb(path.join(DATA_DIR, 'v2.db'));

  const now = new Date().toISOString();
  let group: AgentGroup | undefined = getAgentGroup(AGENT_ID);
  if (!group) {
    group = {
      id: AGENT_ID,
      name: 'Validator',
      folder: AGENT_FOLDER,
      agent_provider: null,
      created_at: now,
    };
    createAgentGroup(group);
    console.log(`[validate-165] created agent group ${AGENT_ID}`);
  } else {
    console.log(`[validate-165] reusing existing agent group ${AGENT_ID}`);
  }

  initGroupFilesystem(group);

  const { session, created } = resolveSession(AGENT_ID, null, null, 'agent-shared');
  console.log(`[validate-165] session ${session.id} (${created ? 'new' : 'existing'})`);

  const messageId = `msg-validate-${Date.now()}`;
  writeSessionMessage(AGENT_ID, session.id, {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: 'validate-165',
    channelType: 'validate-165',
    content: JSON.stringify({ text: 'Reply with exactly one word: PONG' }),
    trigger: 1,
  });
  console.log(`[validate-165] wrote inbound message ${messageId}`);

  await wakeContainer(session);
  console.log(`[validate-165] container wake requested — polling outbound.db...`);

  const deadline = Date.now() + 90_000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const db = openOutboundDb(AGENT_ID, session.id);
    try {
      const rows = db
        .prepare('SELECT id, kind, content, timestamp FROM messages_out ORDER BY seq DESC')
        .all() as Array<{ id: string; kind: string; content: string; timestamp: string }>;
      if (rows.length > 0 && rows.length !== lastCount) {
        console.log(`[validate-165] outbound has ${rows.length} row(s)`);
        lastCount = rows.length;
      }
      const chat = rows.find((r) => r.kind === 'chat');
      if (chat) {
        let text: string;
        try {
          text = (JSON.parse(chat.content) as { text?: string }).text ?? chat.content;
        } catch {
          text = chat.content;
        }
        console.log('\n=== RESPONSE ===');
        console.log(text);
        console.log('================\n');
        console.log(
          `[validate-165] SUCCESS — round-trip complete in ${Math.round((Date.now() - +new Date(now)) / 1000)}s`,
        );
        process.exit(0);
      }
    } finally {
      db.close();
    }
    await sleep(2000);
  }

  console.error('[validate-165] TIMEOUT — no chat response in outbound.db after 90s');
  console.error('[validate-165] check host logs (pnpm run dev) and `docker ps` for the agent container');
  process.exit(1);
}

main().catch((err) => {
  console.error('[validate-165] fatal error:', err);
  process.exit(2);
});
