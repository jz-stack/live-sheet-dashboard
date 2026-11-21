export class LocalLogger {
  constructor({ capacity = 200, sink = console } = {}) {
    this.capacity = capacity;
    this.sink = sink;
    this.entries = [];
  }

  write(level, message, context = {}) {
    const entry = { at: new Date().toISOString(), level, message, ...context };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    const line = JSON.stringify(entry);
    if (level === 'error') this.sink.error(line);
    else if (level === 'warn') this.sink.warn(line);
    else this.sink.log(line);
  }

  info(message, context) { this.write('info', message, context); }
  warn(message, context) { this.write('warn', message, context); }
  error(message, context) { this.write('error', message, context); }

  recent(limit = 100) {
    return this.entries.slice(-Math.max(1, Math.min(limit, this.capacity)));
  }
}
