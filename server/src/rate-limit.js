/**
 * Call limits per IP (sliding window), kept in memory: the catalog runs as a single copy
 * (see single-instance.js). Entries of IPs with no recent calls are swept from time to time,
 * so the memory doesn't grow with every IP that ever reached the portal.
 */

/** All limiters, swept by one timer that doesn't keep the process alive. */
const limiters = new Set();
const SWEEP_EVERY_MS = 60_000;
let timer = null;

function sweepAll(now = Date.now()) {
  for (const l of limiters) l.sweep(now);
}

/**
 * `max` calls per `windowMs` for each key. Returns { hit(key, now?) → true when over the limit,
 * sweep(now?) → number of keys removed, size() }.
 */
function createLimiter(max, windowMs) {
  /** key → timestamps of the calls inside the window, oldest first */
  const hits = new Map();

  const limiter = {
    hit(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return true;
      }
      recent.push(now);
      hits.set(key, recent);
      return false;
    },
    sweep(now = Date.now()) {
      let removed = 0;
      for (const [key, times] of hits) {
        // The newest call is the last one: if even it is outside the window, nothing counts anymore.
        if (!times.length || now - times[times.length - 1] >= windowMs) {
          hits.delete(key);
          removed++;
        }
      }
      return removed;
    },
    size: () => hits.size,
  };

  limiters.add(limiter);
  if (!timer) {
    timer = setInterval(sweepAll, SWEEP_EVERY_MS);
    timer.unref();
  }
  return limiter;
}

/** Express middleware: 429 with `message` once the IP goes over the limit. */
function rateLimit(max, windowMs, message = 'Muitas perguntas seguidas. Espere um pouco e tente de novo.') {
  const limiter = createLimiter(max, windowMs);
  return (req, res, next) => {
    if (limiter.hit(req.ip)) return res.status(429).json({ message });
    next();
  };
}

module.exports = { createLimiter, rateLimit, sweepAll };
