// Role B: DSH as a codex app-server. The agent-bridge daemon spawns
// `codex app-server --listen ws://127.0.0.1:<port>` and then connects to it;
// if PATH points at our stub (`abg-dsh stub`), the daemon connects to THIS
// server instead, making DSH the "codex" of an abg claude pair.
//
// Wire protocol implemented here is the codex app-server subset that the
// daemon's client actually uses (thread/start, thread/resume, turn/start +
// the item/turn notification family). Approval requests are answered with a
// rejection.

import {
  APP_SERVER_METHODS,
  NOTIFICATIONS,
  SERVER_REQUESTS,
  USER_AGENT,
  firstText,
  makeNotification,
  makeRequest,
  makeResponse,
  makeError,
  isRequest,
  isResponse,
  isNotification,
  parseFrame,
  textInput,
} from "./protocol.js";

export class DshAppServer {
  constructor({ port = 4510, mock = false, log = console.error } = {}) {
    this.port = port;
    this.mock = mock;
    this.log = log;
    this.server = null;
    this.nextThread = 0;
    this.nextTurn = 0;
    this.nextItem = 0;
    this.threads = new Map(); // threadId -> {turnId, pending: []}
    this.pendingInbound = []; // {threadId, turnId, text} waiting for the DSH agent
    this.waiters = []; // resolvers for getMessages
    this.initialized = false;
    this.ws = null; // current daemon connection
  }

  async start() {
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === "/healthz" || url.pathname === "/readyz") {
          return new Response("ok");
        }
        const isUpgrade = (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
        if (isUpgrade) {
          if (server.upgrade(req)) return;
          return new Response("upgrade failed", { status: 400 });
        }
        return new Response("dsh app-server (agentbridge-dsh)", { status: 200 });
      },
      websocket: {
        open: (ws) => {
          this.ws = ws;
          this.log(`[app-server] daemon connection open (${this.port})`);
        },
        message: (ws, raw) => this._onFrame(ws, raw),
        close: (ws) => {
          if (this.ws === ws) this.ws = null;
          this.log("[app-server] daemon connection closed");
        },
      },
    });
    this.log(`[app-server] listening on ws://127.0.0.1:${this.port}`);
    return this;
  }

  stop() {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  _onFrame(ws, raw) {
    const msg = parseFrame(raw);
    if (!msg) return;
    if (isRequest(msg)) {
      this._onRequest(ws, msg);
      return;
    }
    if (isNotification(msg)) {
      if (msg.method === APP_SERVER_METHODS.INITIALIZED) this.initialized = true;
      return;
    }
    if (isResponse(msg)) {
      // We never issue requests in the current protocol surface; ignore.
      return;
    }
  }

  _onRequest(ws, msg) {
    const { method, id, params = {} } = msg;
    switch (method) {
      case APP_SERVER_METHODS.INITIALIZE:
        this.initialized = true;
        this._send(makeResponse(id, {
          protocolVersion: 1,
          userAgent: USER_AGENT,
          platformFamily: "dsh",
          platformOs: process.platform,
        }));
        return;

      case APP_SERVER_METHODS.THREAD_START:
        return this._onThreadStart(ws, id, params);

      case APP_SERVER_METHODS.THREAD_RESUME:
        return this._onThreadResume(ws, id, params);

      case APP_SERVER_METHODS.TURN_START:
        // Daemon tracks turn/start as a request; answer with a fresh turn.
        return this._send(makeResponse(id, {
          threadId: params.threadId ?? null,
          turnId: `turn-${++this.nextTurn}`,
        }));

      default:
        if (SERVER_REQUESTS.has(method)) {
          // Approval prompts cannot be answered by an unattended adapter.
          this._send(makeResponse(id, { approved: false, reason: "dsh adapter does not support approvals" }));
          return;
        }
        this._send(makeError(id, -32601, `method not found: ${method}`));
    }
  }

  _onThreadStart(ws, id, params) {
    const text = firstText(params.input);
    let threadId = params.threadId;
    if (!threadId) {
      threadId = `dsh-thread-${++this.nextThread}`;
    }
    const turnId = `turn-${++this.nextTurn}`;
    const itemId = `item-${++this.nextItem}`;
    this.threads.set(threadId, { turnId, itemId, text });

    // codex protocol: respond first, then stream notifications.
    this._send(makeResponse(id, { threadId, turnId }));

    const started = (name, extra = {}) =>
      this._send(makeNotification(name, { threadId, turnId, ...extra }));

    if (this.mock) {
      // Echo behavior: prove the full round trip without a real codex.
      started(NOTIFICATIONS.TURN_STARTED);
      started(NOTIFICATIONS.ITEM_STARTED, { itemId });
      started(NOTIFICATIONS.ITEM_AGENT_MESSAGE_DELTA, {
        itemId,
        content: textInput(`pong from dsh mock app-server (received: ${text.slice(0, 80)})`),
      });
      started(NOTIFICATIONS.ITEM_COMPLETED, { itemId });
      started(NOTIFICATIONS.TURN_COMPLETED, {});
      return;
    }

    // Real mode: hand the message to the DSH agent and wait for a reply.
    this.pendingInbound.push({ threadId, turnId, itemId, text });
    this._wakeWaiters();
  }

  _onThreadResume(ws, id, params) {
    const threadId = params.threadId;
    this._send(makeResponse(id, { threadId }));
    const st = this.threads.get(threadId);
    const turnId = st ? st.turnId : `turn-${++this.nextTurn}`;
    this._send(makeNotification(NOTIFICATIONS.TURN_STARTED, { threadId, turnId }));
  }

  _wakeWaiters() {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }

  // ── DSH-agent facing API (used by the MCP layer) ───────────────────────

  /** Block until at least one inbound message is available (or timeout). */
  async waitForInbound(timeoutMs = 30000) {
    if (this.pendingInbound.length > 0) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== resolve);
        resolve();
      }, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Take and remove all queued inbound messages. */
  drainInbound() {
    const out = this.pendingInbound;
    this.pendingInbound = [];
    return out;
  }

  /** Most recently started thread (fallback reply target). */
  latestThread() {
    let latest = null;
    for (const [, st] of this.threads) latest = st;
    return latest;
  }

  /** Emit the DSH agent's reply as codex agent messages, then close the turn. */
  reply({ threadId, turnId, itemId, text }) {
    const st = this.threads.get(threadId) ?? { itemId, text };
    this._send(makeNotification(NOTIFICATIONS.TURN_STARTED, { threadId, turnId }));
    this._send(makeNotification(NOTIFICATIONS.ITEM_STARTED, { itemId: st.itemId }));
    this._send(makeNotification(NOTIFICATIONS.ITEM_AGENT_MESSAGE_DELTA, {
      threadId,
      turnId,
      itemId: st.itemId,
      content: textInput(text),
    }));
    this._send(makeNotification(NOTIFICATIONS.ITEM_COMPLETED, { threadId, turnId, itemId: st.itemId }));
    this._send(makeNotification(NOTIFICATIONS.TURN_COMPLETED, { threadId, turnId }));
  }
}

// ── codex CLI stub: what the daemon spawns as `codex` ────────────────────
//   codex app-server --help                      -> must mention ws://
//   codex app-server --listen ws://127.0.0.1:P   -> run the server
export function codexStubMain(argv, env = process.env, out = console.log, log = console.error) {
  const args = argv.slice(2);
  if (args[0] === "app-server") {
    if (args.includes("--help") || args.includes("-h")) {
      out(
        "Usage: codex app-server [OPTIONS]\n\nOptions:\n  --listen <ws://127.0.0.1:PORT | unix://PATH>\n  --help\n"
      );
      return 0;
    }
    const listenIdx = args.indexOf("--listen");
    if (listenIdx >= 0 && args[listenIdx + 1]) {
      const url = new URL(args[listenIdx + 1]);
      const port = parseInt(url.port, 10) || 4510;
      const server = new DshAppServer({ port, mock: true, log });
      server.start().catch((e) => {
        log(`[stub] failed to start: ${e.message}`);
        process.exit(1);
      });
      // keep the process alive; the daemon kills us on shutdown
      return null;
    }
  }
  log(`[stub] unhandled invocation: codex ${args.join(" ")}`);
  return 1;
}
