// Tarefas em segundo plano (sincronizações e inclusões em massa) com progresso consultável.

export async function pool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

export class JobManager {
  constructor(db) {
    this.db = db;
    this.active = new Map();
    // Tarefas interrompidas por reinício do servidor
    db.prepare("UPDATE jobs SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running'").run();
  }

  running(type) {
    return [...this.active.values()].find((j) => j.type === type && j.status === 'running');
  }

  start(type, title, fn, { exclusive = true } = {}) {
    if (exclusive) {
      const r = this.running(type);
      if (r) return r;
    }
    const id = Number(this.db.prepare("INSERT INTO jobs(type, title, status) VALUES (?, ?, 'running')").run(type, title).lastInsertRowid);
    const job = {
      id,
      type,
      title,
      status: 'running',
      total: 0,
      done: 0,
      failed: 0,
      message: '',
      log: [],
      created_at: new Date().toISOString(),
      finished_at: null,
      setTotal: (n) => (job.total = n),
      addTotal: (n) => (job.total += n),
      step: (msg) => (job.message = msg),
      ok: (msg) => {
        job.done++;
        if (msg) job.log.push({ ok: true, msg });
      },
      fail: (msg) => {
        job.done++;
        job.failed++;
        job.log.push({ ok: false, msg });
      },
    };
    this.active.set(id, job);
    Promise.resolve()
      .then(() => fn(job))
      .then(
        () => {
          job.status = job.failed ? 'done_with_errors' : 'done';
        },
        (e) => {
          job.status = 'error';
          job.message = e.message;
          job.log.push({ ok: false, msg: e.message });
        }
      )
      .finally(() => {
        job.finished_at = new Date().toISOString();
        this.db
          .prepare("UPDATE jobs SET status = ?, total = ?, done = ?, failed = ?, message = ?, log = ?, finished_at = datetime('now') WHERE id = ?")
          .run(job.status, job.total, job.done, job.failed, job.message, JSON.stringify(job.log.slice(-2000)), id);
        setTimeout(() => this.active.delete(id), 10 * 60 * 1000).unref();
      });
    return job;
  }

  view(job, withLog = false) {
    const { setTotal, addTotal, step, ok, fail, log, ...rest } = job;
    return { ...rest, log: withLog ? log : undefined, errors: log.filter((l) => !l.ok).length };
  }

  get(id) {
    const j = this.active.get(Number(id));
    if (j) return this.view(j, true);
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, log: JSON.parse(row.log || '[]') };
  }

  list(limit = 30) {
    const rows = this.db.prepare('SELECT id, type, title, status, total, done, failed, message, created_at, finished_at FROM jobs ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => (this.active.has(r.id) ? this.view(this.active.get(r.id)) : r));
  }
}
