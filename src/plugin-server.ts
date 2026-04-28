/**
 * Plugin IPC server — Card #2 (Card A of #173 cluster).
 *
 * Exposes start/stop/deliver/health/output over a Unix socket so the
 * coda-codaclaw provider plugin (running as a short-lived child process
 * spawned by coda) can drive sessions on this long-lived host process.
 *
 * Protocol: line-delimited JSON. Client connects, writes one request
 * terminated by `\n`, reads one response terminated by `\n`, closes.
 * Spec: docs/specs/173-codaclaw-provider.md (in evanstern/coda-codaclaw),
 * §Architecture and §Per-subcommand semantics.
 *
 * Wire-level error contract (every handler):
 *   ok true:  { ok: true, ...result }
 *   ok false: { ok: false, error: "<short stable string>" }
 *
 * Stderr is for operator debug noise; the socket itself returns clean
 * JSON only. Connections are one-shot — see the `\n` framing rationale
 * in the request handler.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { isContainerRunning, isContainerStarting, wakeContainer } from './container-runner.js';
import { createAgentGroup, getAgentGroup } from './db/agent-groups.js';
import { getSession } from './db/sessions.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { openOutboundDb, resolveSession, writeSessionMessage } from './session-manager.js';

/**
 * Inbound message envelope when delivering to a session. Body is utf-8
 * (plugin decodes wire-side `[]byte` before writing this envelope).
 */
export interface InboundMessage {
  id: string;
  from: string;
  type: string;
  body: string;
}

export type PluginRequest =
  | { op: 'start'; agent: string; config?: Record<string, string> }
  | { op: 'stop'; session_id: string }
  | { op: 'deliver'; session_id: string; message: InboundMessage }
  | { op: 'health'; session_id: string }
  | { op: 'output'; session_id: string; since?: string };

export interface PluginErrorResponse {
  ok: false;
  error: string;
}

export type PluginResponse = PluginErrorResponse | { ok: true; [k: string]: unknown };

/** Default socket path. Override with PLUGIN_SOCKET_PATH for tests. */
export function defaultSocketPath(): string {
  return process.env.PLUGIN_SOCKET_PATH || path.join(os.homedir(), '.codaclaw', 'host.sock');
}

let server: net.Server | null = null;
let activeSocketPath: string | null = null;

/**
 * Start the IPC server. Idempotent — calling twice is a no-op (returns
 * the existing path). Cleans up a stale socket file at the path before
 * binding, since a previous crash may have left one.
 */
export async function startPluginServer(socketPath: string = defaultSocketPath()): Promise<string> {
  if (server) {
    log.debug('Plugin server already running', { socketPath: activeSocketPath });
    return activeSocketPath as string;
  }

  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  // Stale socket from a previous crash. Safe to remove — no other process
  // can be listening on it (else our listen() would fail with EADDRINUSE
  // and we'd surface that). Removing a live one would just fail silently
  // on the listen attempt.
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      log.warn('Failed to remove stale plugin socket', { socketPath, err });
    }
  }

  const s = net.createServer(handleConnection);
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(socketPath, () => {
      s.removeListener('error', reject);
      resolve();
    });
  });

  fs.chmodSync(socketPath, 0o600);

  server = s;
  activeSocketPath = socketPath;
  log.info('Plugin server listening', { socketPath });
  return socketPath;
}

/**
 * Stop the IPC server and unlink the socket file. Idempotent. Called from
 * src/index.ts shutdown so a clean exit leaves no socket behind.
 */
export async function stopPluginServer(): Promise<void> {
  if (!server) return;
  const s = server;
  const sockPath = activeSocketPath;
  server = null;
  activeSocketPath = null;

  await new Promise<void>((resolve) => {
    s.close(() => resolve());
  });

  if (sockPath && fs.existsSync(sockPath)) {
    try {
      fs.unlinkSync(sockPath);
    } catch (err) {
      log.warn('Failed to unlink plugin socket on shutdown', { sockPath, err });
    }
  }
  log.info('Plugin server stopped', { sockPath });
}

function handleConnection(sock: net.Socket): void {
  // One-shot framing: read until the first '\n', dispatch, write response,
  // end the socket. Plugin opens fresh socket per subcommand — simplest
  // protocol that fits the per-invocation shape.
  let buf = '';
  sock.setEncoding('utf8');

  sock.on('data', (chunk: string) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    const line = buf.slice(0, nl);
    // Anything after '\n' is ignored — protocol is one request per
    // connection, multi-request is not a v0 feature.
    sock.removeAllListeners('data');
    dispatch(line)
      .then((resp) => {
        sock.write(JSON.stringify(resp) + '\n', () => sock.end());
      })
      .catch((err) => {
        log.error('Plugin dispatch threw', { err });
        const resp: PluginErrorResponse = { ok: false, error: 'internal error' };
        sock.write(JSON.stringify(resp) + '\n', () => sock.end());
      });
  });

  sock.on('error', (err) => {
    log.warn('Plugin socket error', { err });
  });
}

async function dispatch(line: string): Promise<PluginResponse> {
  let req: PluginRequest;
  try {
    req = JSON.parse(line) as PluginRequest;
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!req || typeof req !== 'object' || typeof (req as { op?: unknown }).op !== 'string') {
    return { ok: false, error: 'missing op' };
  }

  switch (req.op) {
    case 'start':
      return handleStart(req);
    case 'stop':
      return handleStop(req);
    case 'deliver':
      return handleDeliver(req);
    case 'health':
      return handleHealth(req);
    case 'output':
      return handleOutput(req);
    default:
      return { ok: false, error: `unknown op: ${(req as { op: string }).op}` };
  }
}

async function handleStart(req: Extract<PluginRequest, { op: 'start' }>): Promise<PluginResponse> {
  const slug = req.agent;
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'missing agent slug' };
  }

  let group = getAgentGroup(slug);
  if (!group) {
    group = {
      id: slug,
      name: slug,
      folder: slug,
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    createAgentGroup(group);
    log.info('Plugin start created agent group', { slug });
  }

  initGroupFilesystem(group);

  const { session, created } = resolveSession(group.id, null, null, 'agent-shared');
  log.info('Plugin start resolved session', { slug, sessionId: session.id, created });

  wakeContainer(session).catch((err) => {
    log.error('Plugin start wakeContainer failed', { sessionId: session.id, err });
  });

  return { ok: true, session_id: session.id };
}

async function handleStop(_req: Extract<PluginRequest, { op: 'stop' }>): Promise<PluginResponse> {
  return { ok: false, error: 'not implemented' };
}

async function handleDeliver(req: Extract<PluginRequest, { op: 'deliver' }>): Promise<PluginResponse> {
  const session = getSession(req.session_id);
  if (!session) {
    return { ok: false, error: 'unknown session' };
  }
  if (!req.message || typeof req.message !== 'object') {
    return { ok: false, error: 'missing message' };
  }
  const { id, from, body } = req.message;
  if (!id || !from || typeof body !== 'string') {
    return { ok: false, error: 'invalid message shape' };
  }

  // channel_type='coda' is the load-bearing per-row discriminant for the
  // Output() cursor-ownership invariant: only coda-mediated rows are
  // drained by the plugin's output op, host delivery skips them.
  // platform_id carries the coda-side sender so the agent-runner's
  // single-destination fallback can route a reply back without a
  // messaging-groups row (mirrors validate-165 wiring).
  writeSessionMessage(session.agent_group_id, session.id, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: from,
    channelType: 'coda',
    content: JSON.stringify({ text: body }),
    trigger: 1,
  });

  wakeContainer(session).catch((err) => {
    log.error('Plugin deliver wakeContainer failed', { sessionId: session.id, err });
  });

  return { ok: true, delivered: true };
}

async function handleHealth(req: Extract<PluginRequest, { op: 'health' }>): Promise<PluginResponse> {
  const session = getSession(req.session_id);
  if (!session) {
    return { ok: false, error: 'unknown session' };
  }

  if (isContainerRunning(req.session_id)) {
    return { ok: true, state: 'running', healthy: true, detail: '' };
  }
  if (isContainerStarting(req.session_id)) {
    return { ok: true, state: 'started', healthy: false, detail: 'container starting' };
  }
  if (session.last_active === null) {
    return { ok: true, state: 'created', healthy: false, detail: 'awaiting wakeContainer' };
  }
  return { ok: true, state: 'stopped', healthy: false, detail: 'exited normally' };
}

async function handleOutput(req: Extract<PluginRequest, { op: 'output' }>): Promise<PluginResponse> {
  const session = getSession(req.session_id);
  if (!session) {
    return { ok: false, error: 'unknown session' };
  }

  // channel_type='coda' is the Output() cursor-ownership filter — coda
  // owns the cursor on these rows, host delivery must skip them. See
  // deliver op for the writer side of this invariant.
  const since = req.since;
  const db = openOutboundDb(session.agent_group_id, session.id);
  try {
    const rows = since
      ? (db
          .prepare(
            `SELECT id, timestamp, kind, content
             FROM messages_out
             WHERE channel_type = 'coda' AND timestamp > ?
             ORDER BY seq ASC`,
          )
          .all(since) as Array<{ id: string; timestamp: string; kind: string; content: string }>)
      : (db
          .prepare(
            `SELECT id, timestamp, kind, content
             FROM messages_out
             WHERE channel_type = 'coda'
             ORDER BY seq ASC`,
          )
          .all() as Array<{ id: string; timestamp: string; kind: string; content: string }>);

    const messages = rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      type: r.kind,
      body: r.content,
    }));
    return { ok: true, messages };
  } finally {
    db.close();
  }
}
