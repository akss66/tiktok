const crypto = require('crypto');

const WRITE_RESOURCE = 'douyin_write';
const DEFAULT_WRITE_LEASE_TTL_MS = 120000;
const DEFAULT_WRITE_LEASE_POLL_MS = 250;
const DEFAULT_WRITE_LEASE_HEARTBEAT_MS = 40000;
const MIN_WRITE_LEASE_TTL_MS = 50;
const MAX_WRITE_LEASE_TTL_MS = 600000;
const MIN_WRITE_LEASE_HEARTBEAT_MS = 10;
const activeExecutionGates = new Map();

function isoAt(now, offsetMs = 0) {
  return new Date(now + offsetMs).toISOString();
}

function withImmediateTransaction(db, fn) {
  if (db.inTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function activeLeaseRow(db, now) {
  return db.prepare(`
    SELECT * FROM operation_leases
    WHERE resource = ? AND lease_expires_at > ?
  `).get(WRITE_RESOURCE, isoAt(now));
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireWriteLeaseTtlMs(value, defaultValue = DEFAULT_WRITE_LEASE_TTL_MS) {
  const ttlMs = value === undefined ? defaultValue : value;
  if (!Number.isFinite(ttlMs)
    || !Number.isInteger(ttlMs)
    || ttlMs < MIN_WRITE_LEASE_TTL_MS
    || ttlMs > MAX_WRITE_LEASE_TTL_MS) {
    throw new TypeError(
      `ttlMs must be an integer between ${MIN_WRITE_LEASE_TTL_MS} and ${MAX_WRITE_LEASE_TTL_MS}`,
    );
  }
  return ttlMs;
}

function acquireWriteLease(db, owner, ttlMs = 60_000, now = Date.now()) {
  const safeOwner = requireNonEmptyString(owner, 'owner');
  const safeTtlMs = requireWriteLeaseTtlMs(ttlMs, 60_000);
  return withImmediateTransaction(db, () => {
    const active = activeLeaseRow(db, now);
    if (active) {
      return {
        acquired: false,
        owner: active.owner,
        token: null,
        leaseExpiresAt: active.lease_expires_at,
      };
    }
    const token = crypto.randomUUID();
    const timestamp = isoAt(now);
    const leaseExpiresAt = isoAt(now, safeTtlMs);
    db.prepare(`
      INSERT INTO operation_leases (
        resource, owner, token, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource) DO UPDATE SET
        owner = excluded.owner,
        token = excluded.token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
    `).run(
      WRITE_RESOURCE,
      safeOwner,
      token,
      leaseExpiresAt,
      timestamp,
      timestamp,
    );
    return {
      acquired: true,
      owner: safeOwner,
      token,
      leaseExpiresAt,
    };
  });
}

function renewWriteLease(db, token, ttlMs = 60_000, now = Date.now()) {
  const safeToken = requireNonEmptyString(token, 'token');
  const safeTtlMs = requireWriteLeaseTtlMs(ttlMs, 60_000);
  return withImmediateTransaction(db, () => {
    const leaseExpiresAt = isoAt(now, safeTtlMs);
    const changes = db.prepare(`
      UPDATE operation_leases
      SET lease_expires_at = ?, updated_at = ?
      WHERE resource = ? AND token = ?
    `).run(leaseExpiresAt, isoAt(now), WRITE_RESOURCE, safeToken).changes;
    return {
      renewed: changes > 0,
      token: safeToken,
      leaseExpiresAt: changes > 0 ? leaseExpiresAt : null,
    };
  });
}

function releaseWriteLease(db, token) {
  const safeToken = requireNonEmptyString(token, 'token');
  return withImmediateTransaction(db, () => (
    db.prepare('DELETE FROM operation_leases WHERE resource = ? AND token = ?')
      .run(WRITE_RESOURCE, safeToken)
      .changes > 0
  ));
}

function resolveWriteLeaseTtlMs(options = {}) {
  const requested = options.ttlMs !== undefined ? options.ttlMs : options.writeLeaseTtlMs;
  return requireWriteLeaseTtlMs(requested, DEFAULT_WRITE_LEASE_TTL_MS);
}

function resolveWriteLeasePollMs(options = {}) {
  return Math.max(50, Number(options.pollMs || options.writeLeasePollMs || DEFAULT_WRITE_LEASE_POLL_MS));
}

function resolveWriteLeaseHeartbeatMs(ttlMs, options = {}) {
  const requested = options.heartbeatMs ?? options.writeLeaseHeartbeatMs;
  const maxInterval = Math.max(MIN_WRITE_LEASE_HEARTBEAT_MS, ttlMs - 10);
  if (requested !== undefined && requested !== null && requested !== '') {
    return Math.min(maxInterval, Math.max(MIN_WRITE_LEASE_HEARTBEAT_MS, Number(requested)));
  }
  return Math.min(maxInterval, Math.max(30_000, Math.min(DEFAULT_WRITE_LEASE_HEARTBEAT_MS, Math.floor(ttlMs / 3))));
}

function getActiveExecutionGate() {
  return activeExecutionGates.get(WRITE_RESOURCE) || null;
}

function setActiveExecutionGate(owner, lease) {
  const gate = {
    owner,
    token: lease.token,
    leaseExpiresAt: lease.leaseExpiresAt,
  };
  activeExecutionGates.set(WRITE_RESOURCE, gate);
  return gate;
}

function clearActiveExecutionGate(token) {
  const current = activeExecutionGates.get(WRITE_RESOURCE);
  if (current?.token === token) {
    activeExecutionGates.delete(WRITE_RESOURCE);
  }
}

async function waitForWriteLease(db, owner, options = {}) {
  const ttlMs = resolveWriteLeaseTtlMs(options);
  const pollMs = resolveWriteLeasePollMs(options);
  const maxWaitMs = options.maxWaitMs ?? options.writeLeaseMaxWaitMs;
  const maxAttempts = Number.isFinite(Number(maxWaitMs))
    ? Math.max(0, Math.ceil(Number(maxWaitMs) / pollMs))
    : null;
  const sleepFn = options.sleepFn || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  let attempt = 0;
  while (true) {
    const activeExecution = getActiveExecutionGate();
    if (activeExecution) {
      const blocked = {
        acquired: false,
        owner: activeExecution.owner,
        token: null,
        leaseExpiresAt: activeExecution.leaseExpiresAt,
        localExecution: true,
      };
      options.onWait?.(blocked);
      if (options.shouldStop?.()) return null;
      if (maxAttempts !== null && attempt >= maxAttempts) {
        return {
          ...blocked,
          timedOut: true,
        };
      }
      await sleepFn(pollMs);
      attempt += 1;
      if (options.shouldStop?.()) return null;
      continue;
    }
    const lease = acquireWriteLease(db, owner, ttlMs);
    if (lease.acquired) return lease;
    options.onWait?.(lease);
    if (options.shouldStop?.()) return null;
    if (maxAttempts !== null && attempt >= maxAttempts) {
      return {
        acquired: false,
        owner: lease.owner,
        token: null,
        leaseExpiresAt: lease.leaseExpiresAt,
        timedOut: true,
      };
    }
    await sleepFn(pollMs);
    attempt += 1;
    if (options.shouldStop?.()) return null;
  }
}

async function runWithLeaseHeartbeat(db, lease, owner, action, options = {}) {
  if (!lease?.acquired) {
    throw new Error(`Global Douyin write lease unavailable for ${owner}`);
  }
  const ttlMs = resolveWriteLeaseTtlMs(options);
  const heartbeatMs = resolveWriteLeaseHeartbeatMs(ttlMs, options);
  const renewLeaseFn = options.renewLeaseFn || renewWriteLease;
  let timer = null;
  let renewPromise = null;
  let stopped = false;
  let heartbeatError = null;
  let signalHeartbeatFailure;
  const heartbeatFailure = new Promise((resolve) => {
    signalHeartbeatFailure = resolve;
  });
  const failHeartbeat = (error) => {
    if (heartbeatError) return;
    heartbeatError = error instanceof Error
      ? error
      : new Error(String(error || `Global Douyin write lease renewal failed for ${owner}`));
    signalHeartbeatFailure(heartbeatError);
  };
  const gate = setActiveExecutionGate(owner, lease);
  const scheduleHeartbeat = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      renewPromise = (async () => {
        try {
          const renewed = await renewLeaseFn(db, lease.token, ttlMs);
          if (!renewed?.renewed) {
            throw new Error(`Global Douyin write lease renewal failed for ${owner}`);
          }
          gate.leaseExpiresAt = renewed.leaseExpiresAt;
          options.onHeartbeat?.(renewed);
          renewPromise = null;
          scheduleHeartbeat();
        } catch (error) {
          renewPromise = null;
          stopped = true;
          failHeartbeat(error);
        }
      })();
      renewPromise.catch(() => {});
    }, heartbeatMs);
    if (typeof timer?.unref === 'function') timer.unref();
  };
  const stopHeartbeat = async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (renewPromise) {
      await Promise.allSettled([renewPromise]);
      renewPromise = null;
    }
  };
  scheduleHeartbeat();
  const actionPromise = Promise.resolve()
    .then(() => action(lease))
    .then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    );
  let actionResult;
  try {
    const firstEvent = await Promise.race([
      actionPromise.then(() => 'action'),
      heartbeatFailure.then(() => 'heartbeat'),
    ]);
    actionResult = firstEvent === 'action' ? await actionPromise : await actionPromise;
    await stopHeartbeat();
    if (heartbeatError && actionResult.status === 'rejected') {
      throw new AggregateError(
        [heartbeatError, actionResult.reason],
        `Global Douyin write lease renewal failed while action also failed for ${owner}`,
      );
    }
    if (heartbeatError) throw heartbeatError;
    if (actionResult.status === 'rejected') throw actionResult.reason;
    return actionResult.value;
  } catch (error) {
    actionResult = actionResult || await actionPromise;
    await stopHeartbeat();
    if (heartbeatError && actionResult?.status === 'rejected') {
      throw new AggregateError(
        [heartbeatError, actionResult.reason],
        `Global Douyin write lease renewal failed while action also failed for ${owner}`,
      );
    }
    if (heartbeatError) throw heartbeatError;
    if (actionResult?.status === 'rejected') throw actionResult.reason;
    throw error;
  } finally {
    clearActiveExecutionGate(lease.token);
    releaseWriteLease(db, lease.token);
  }
}

async function withWriteLease(db, owner, action, options = {}) {
  if (options.skipWriteLease) return action();
  const lease = await waitForWriteLease(db, owner, options);
  return runWithLeaseHeartbeat(db, lease, owner, action, options);
}

module.exports = {
  MAX_WRITE_LEASE_TTL_MS,
  MIN_WRITE_LEASE_TTL_MS,
  acquireWriteLease,
  releaseWriteLease,
  renewWriteLease,
  runWithLeaseHeartbeat,
  waitForWriteLease,
  withWriteLease,
};
