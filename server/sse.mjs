export class SseNotifier {
  constructor({ config, logger, metrics }) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.clients = new Set();
    this.heartbeat = setInterval(() => this.ping(), 25_000);
    this.heartbeat.unref?.();
  }

  add(req, res, initialState) {
    if (this.clients.size >= this.config.MAX_SSE_CLIENTS) return false;
    const client = { res, blocked: false, pending: null };
    this.clients.add(client);
    const remove = () => this.clients.delete(client);
    req.on('close', remove);
    res.on('close', remove);
    res.on('error', remove);
    res.on('drain', () => {
      client.blocked = false;
      if (!client.pending) return;
      const pending = client.pending;
      client.pending = null;
      this.write(client, pending);
    });
    this.write(client, 'retry: 2000\n\n');
    this.write(client, `event: ready\ndata: ${JSON.stringify(initialState)}\n\n`);
    return true;
  }

  disconnect(client) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    this.metrics.increment('slowClients');
    client.res.destroy();
  }

  write(client, frame, { heartbeat = false } = {}) {
    if (client.res.destroyed || client.res.writableEnded) {
      this.clients.delete(client);
      return;
    }
    if (client.blocked) {
      if (!heartbeat) client.pending = frame;
      if (Buffer.byteLength(client.pending || '') + client.res.writableLength > this.config.MAX_SSE_BUFFER_BYTES) {
        this.disconnect(client);
      }
      return;
    }
    if (client.res.writableLength + Buffer.byteLength(frame) > this.config.MAX_SSE_BUFFER_BYTES) {
      this.disconnect(client);
      return;
    }
    try {
      if (!resWrite(client.res, frame)) client.blocked = true;
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(event, payload) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const frame = `event: ${event}\ndata: ${body}\n\n`;
    for (const client of this.clients) this.write(client, frame);
  }

  ping() {
    for (const client of this.clients) this.write(client, ': ping\n\n', { heartbeat: true });
  }

  count() { return this.clients.size; }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.res.destroy();
    this.clients.clear();
  }
}

function resWrite(response, frame) {
  return response.write(frame);
}
