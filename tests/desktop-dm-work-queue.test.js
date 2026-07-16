const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const inbox = require('../lib/desktop/dm-inbox');
const queue = require('../lib/desktop/dm-work-queue');
const leases = require('../lib/desktop/operation-lease');

describe('desktop dm work queue', () => {
  let dir;
  let db;
  let account;
  let firstConversation;
  let secondConversation;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-dm-work-queue-'));
    db = openDesktopDb({ storageDir: dir });
    account = accounts.createAccount(db, { name: '账号A' });
    inbox.ingestMessages(db, {
      accountId: account.id,
      messages: [
        {
          conversation_id: 'conv-1',
          index: '1',
          sender: 'user-1',
          content: '你好',
          timestamp: 1000,
        },
        {
          conversation_id: 'conv-2',
          index: '1',
          sender: 'user-2',
          content: '在吗',
          timestamp: 2000,
        },
      ],
    });
    firstConversation = inbox.getConversationByPlatformId(db, account.id, 'conv-1');
    secondConversation = inbox.getConversationByPlatformId(db, account.id, 'conv-2');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claims only one ready work item at a time and recovers an expired claim', () => {
    const first = queue.enqueueWork(db, {
      type: 'analyze',
      accountId: account.id,
      conversationId: firstConversation.id,
      payload: { step: 1 },
    });
    const second = queue.enqueueWork(db, {
      type: 'history_sync',
      accountId: account.id,
      conversationId: secondConversation.id,
      payload: { step: 2 },
    });

    const claimed = queue.claimNextWork(db, 'worker-a', 1_000);
    expect(claimed.id).toBe(first.id);
    expect(claimed.status).toBe('running');
    expect(claimed.workerId).toBe('worker-a');
    expect(claimed.claimToken).toMatch(/^[a-f0-9]{64}$/);
    expect(queue.claimNextWork(db, 'worker-b', 1_000)).toBeNull();

    expect(queue.recoverInterruptedWork(db, 62_000)).toBe(1);
    const recovered = queue.claimNextWork(db, 'worker-b', 62_000);
    expect(recovered.id).toBe(first.id);
    expect(recovered.claimToken).toMatch(/^[a-f0-9]{64}$/);
    expect(recovered.claimToken).not.toBe(claimed.claimToken);
    queue.completeWork(db, recovered.id, { ok: true }, {
      workerId: recovered.workerId,
      claimToken: recovered.claimToken,
      now: 62_500,
    });
    expect(queue.getWork(db, recovered.id).claimToken).toBeNull();

    const next = queue.claimNextWork(db, 'worker-c', 63_000);
    expect(next.id).toBe(second.id);
  });

  it('rejects an old send claim after the same worker id reclaims the work', () => {
    const pending = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: firstConversation.id,
      content: 'claim-bound reply',
    });
    const work = queue.enqueueWork(db, {
      type: 'send_manual', accountId: account.id, conversationId: firstConversation.id,
      messageId: pending.message.id, dedupeKey: 'same-worker-reclaim-send', payload: { text: 'reply' },
    });
    const oldClaim = queue.claimNextWork(db, 'same-worker', 1_000, { types: ['send_manual'] });
    expect(queue.recoverInterruptedWork(db, 62_000)).toBe(1);
    const freshClaim = queue.claimNextWork(db, 'same-worker', 62_000, { types: ['send_manual'] });
    expect(freshClaim.claimToken).not.toBe(oldClaim.claimToken);

    expect(() => queue.markWorkExecutionStarted(
      db, work.id, oldClaim.workerId, oldClaim.claimToken, 62_500,
    )).toThrow(/claim/i);
    expect(() => queue.failWork(db, work.id, new Error('stale failure'), {
      workerId: oldClaim.workerId, claimToken: oldClaim.claimToken, now: 62_500,
    })).toThrow(/claim/i);
    expect(queue.getWork(db, work.id)).toMatchObject({
      status: 'running', workerId: 'same-worker', claimToken: freshClaim.claimToken,
      attemptCount: 0, error: null,
    });

    queue.markWorkExecutionStarted(
      db, work.id, freshClaim.workerId, freshClaim.claimToken, 63_000,
    );
    const completed = queue.completeWork(db, work.id, { messageId: 'sent-once' }, {
      workerId: freshClaim.workerId, claimToken: freshClaim.claimToken, now: 63_500,
    });
    expect(completed).toMatchObject({ status: 'success', result: { messageId: 'sent-once' } });
    expect(completed.claimToken).toBeNull();

    expect(() => queue.completeWork(db, work.id, { messageId: 'stale-overwrite' }, {
      workerId: oldClaim.workerId, claimToken: oldClaim.claimToken, now: 64_000,
    })).toThrow(/claim/i);
    expect(queue.completeWork(db, work.id, { messageId: 'winner-replay' }, {
      workerId: freshClaim.workerId, claimToken: freshClaim.claimToken, now: 64_000,
    })).toMatchObject({ status: 'success', result: { messageId: 'sent-once' } });
  });

  it('uses the exact retry backoff schedule and fails after the attempt limit', () => {
    const work = queue.enqueueWork(db, {
      type: 'send_manual',
      accountId: account.id,
      conversationId: firstConversation.id,
      payload: { text: '跟进' },
      maxAttempts: 6,
    });

    const expectedOffsets = [30_000, 60_000, 120_000, 300_000, 600_000];
    let now = 10_000;
    for (const offset of expectedOffsets) {
      const claimed = queue.claimNextWork(db, `worker-${offset}`, now);
      expect(claimed.id).toBe(work.id);
      const failed = queue.failWork(db, claimed.id, new Error(`retry-${offset}`), {
        workerId: claimed.workerId, claimToken: claimed.claimToken, now,
      });
      expect(failed.status).toBe('pending');
      expect(failed.attemptCount).toBeGreaterThan(0);
      expect(failed.nextRunAt).toBe(new Date(now + offset).toISOString());
      now += offset;
    }

    const finalClaim = queue.claimNextWork(db, 'worker-final', now);
    const exhausted = queue.failWork(db, finalClaim.id, new Error('final failure'), {
      workerId: finalClaim.workerId, claimToken: finalClaim.claimToken, now,
    });
    expect(exhausted.status).toBe('failed');
    expect(exhausted.attemptCount).toBe(6);
    expect(exhausted.nextRunAt).toBeNull();
  });

  it('rejects unsupported queue types at the module boundary', () => {
    expect(() => queue.enqueueWork(db, {
      type: 'publish',
      accountId: account.id,
      conversationId: firstConversation.id,
      payload: {},
    })).toThrow(/unsupported dm work type/i);
  });

  it('backfills native Douyin text messages into analysis work exactly once', () => {
    const ingested = inbox.ingestMessages(db, {
      accountId: account.id,
      messages: [{
        conversation_id: 'conv-native-text',
        index: '7',
        sender: 'user-native',
        content: 'native text payload',
        message_type: 7,
        timestamp: 3000,
      }],
    });

    expect(ingested.insertedMessages[0].messageType).toBe('7');
    expect(queue.enqueueMissingAnalysisWork(db)).toBe(3);
    expect(queue.enqueueMissingAnalysisWork(db)).toBe(0);

    const rows = db.prepare(`
      SELECT message_id AS messageId, type
      FROM dm_work_items
      WHERE type = 'analyze'
      ORDER BY created_at ASC, id ASC
    `).all();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.messageId)).toContain(ingested.insertedMessages[0].id);
  });

  it('returns the latest analysis work for a conversation', () => {
    const first = queue.enqueueWork(db, {
      type: 'analyze',
      accountId: account.id,
      conversationId: firstConversation.id,
      messageId: 'message-one',
      dedupeKey: 'source-message:message-one',
    });
    const second = queue.enqueueWork(db, {
      type: 'analyze',
      accountId: account.id,
      conversationId: firstConversation.id,
      messageId: 'message-two',
      dedupeKey: 'source-message:message-two',
    });

    expect(queue.getLatestAnalysisWork(db, firstConversation.id).id).toBe(second.id);
    expect(queue.getLatestAnalysisWork(db, secondConversation.id)).toBeNull();
    expect(first.id).not.toBe(second.id);
  });

  it('allows only one global Douyin write lease', () => {
    const first = leases.acquireWriteLease(db, 'batch:item-1', 60_000, 1_000);
    expect(first.acquired).toBe(true);

    const blocked = leases.acquireWriteLease(db, 'dm:message-1', 60_000, 1_000);
    expect(blocked.acquired).toBe(false);
    expect(blocked.owner).toBe('batch:item-1');

    expect(leases.releaseWriteLease(db, first.token)).toBe(true);

    const second = leases.acquireWriteLease(db, 'dm:message-1', 60_000, 1_000);
    expect(second.acquired).toBe(true);
  });

  it.each(['60', Number.NaN, 0, -1, 49, 600_001, 1.5, Number.POSITIVE_INFINITY])(
    'rejects invalid write lease ttl %s at the module boundary',
    (ttlMs) => {
      expect(() => leases.acquireWriteLease(db, 'writer', ttlMs, 1_000))
        .toThrow(/ttlMs.*integer.*50.*600000/i);
    },
  );

  it.each([undefined, null, '', '   ', 123])(
    'rejects invalid write lease owner %s at the module boundary',
    (owner) => {
      expect(() => leases.acquireWriteLease(db, owner, 60_000, 1_000))
        .toThrow(/owner.*non-empty string/i);
    },
  );

  it('validates renew tokens and ttl without changing the active lease', () => {
    const lease = leases.acquireWriteLease(db, 'writer', 60_000, 1_000);

    expect(() => leases.renewWriteLease(db, 123, 60_000, 2_000))
      .toThrow(/token.*non-empty string/i);
    expect(() => leases.renewWriteLease(db, lease.token, '60000', 2_000))
      .toThrow(/ttlMs.*integer.*50.*600000/i);
    expect(leases.renewWriteLease(db, lease.token, 50, 2_000)).toMatchObject({ renewed: true });
  });

  it('accepts the inclusive write lease ttl boundaries', () => {
    const minimum = leases.acquireWriteLease(db, 'minimum-writer', 50, 1_000);
    expect(minimum.acquired).toBe(true);
    expect(leases.releaseWriteLease(db, minimum.token)).toBe(true);

    const maximum = leases.acquireWriteLease(db, 'maximum-writer', 600_000, 1_000);
    expect(maximum.acquired).toBe(true);
  });

  it('keeps renewing the write lease while a long action is still running', async () => {
    let releaseAction;
    const heartbeats = [];
    const running = leases.withWriteLease(db, 'long-action', async () => new Promise((resolve) => {
      releaseAction = resolve;
    }), {
      ttlMs: 90,
      heartbeatMs: 30,
      onHeartbeat: (lease) => heartbeats.push(lease.leaseExpiresAt),
    });

    await new Promise((resolve) => setTimeout(resolve, 140));
    const blocked = leases.acquireWriteLease(db, 'second-writer', 90);
    expect(blocked.acquired).toBe(false);
    expect(heartbeats.length).toBeGreaterThan(0);

    releaseAction('done');
    await expect(running).resolves.toBe('done');
  });

  it('stops heartbeats and releases the lease after completion or error', async () => {
    const completionHeartbeats = [];
    await leases.withWriteLease(db, 'complete-action', async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return 'ok';
    }, {
      ttlMs: 80,
      heartbeatMs: 20,
      onHeartbeat: () => completionHeartbeats.push(Date.now()),
    });
    const completionCount = completionHeartbeats.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(completionHeartbeats.length).toBe(completionCount);
    expect(leases.acquireWriteLease(db, 'post-complete', 80).acquired).toBe(true);

    const errorHeartbeats = [];
    await expect(leases.withWriteLease(db, 'throw-action', async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      throw new Error('boom');
    }, {
      ttlMs: 80,
      heartbeatMs: 20,
      onHeartbeat: () => errorHeartbeats.push(Date.now()),
    })).rejects.toThrow('boom');
    const errorCount = errorHeartbeats.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(errorHeartbeats.length).toBe(errorCount);
    expect(leases.acquireWriteLease(db, 'post-error', 80).acquired).toBe(true);
  });

  it('stays pending on heartbeat failure until the action settles and blocks a second writer locally', async () => {
    let releaseFirst;
    let firstSettled = false;
    const first = leases.withWriteLease(db, 'first-writer', async () => new Promise((resolve) => {
      releaseFirst = () => resolve('first-done');
    }), {
      ttlMs: 80,
      heartbeatMs: 20,
      renewLeaseFn: async () => ({ renewed: false }),
    }).finally(() => {
      firstSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(firstSettled).toBe(false);

    let secondCalls = 0;
    const second = leases.withWriteLease(db, 'second-writer', async () => {
      secondCalls += 1;
      return 'second-done';
    }, {
      ttlMs: 80,
      heartbeatMs: 20,
      pollMs: 20,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(secondCalls).toBe(0);

    releaseFirst();
    await expect(first).rejects.toThrow(/write lease renewal failed|heartbeat/i);
    await expect(second).resolves.toBe('second-done');
    expect(secondCalls).toBe(1);
  });

  it('keeps the local write gate until a failing action settles after heartbeat failure', async () => {
    let rejectFirst;
    let firstSettled = false;
    const first = leases.withWriteLease(db, 'failing-first-writer', async () => new Promise((_, reject) => {
      rejectFirst = () => reject(new Error('action failed'));
    }), {
      ttlMs: 80,
      heartbeatMs: 20,
      renewLeaseFn: async () => ({ renewed: false }),
    }).finally(() => {
      firstSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(firstSettled).toBe(false);

    let secondCalls = 0;
    const second = leases.withWriteLease(db, 'after-failure-writer', async () => {
      secondCalls += 1;
      return 'recovered';
    }, {
      ttlMs: 80,
      heartbeatMs: 20,
      pollMs: 20,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(secondCalls).toBe(0);

    rejectFirst();
    await expect(first).rejects.toThrow(/renewal failed|action failed/i);
    await expect(second).resolves.toBe('recovered');
    expect(secondCalls).toBe(1);
  });

  it('prioritizes manual sends and can claim only requested work types', () => {
    queue.enqueueWork(db, {
      type: 'analyze', accountId: account.id, conversationId: firstConversation.id,
      dedupeKey: 'analysis-first', payload: {},
    });
    const manual = queue.enqueueWork(db, {
      type: 'send_manual', accountId: account.id, conversationId: firstConversation.id,
      dedupeKey: 'manual-second', payload: { text: 'reply' },
    });

    const claimed = queue.claimNextWork(db, 'manual-worker', Date.now(), { types: ['send_manual'] });
    expect(claimed.id).toBe(manual.id);
    expect(claimed.type).toBe('send_manual');
  });

  it('keeps complete and fail transitions idempotent after a terminal state', () => {
    const work = queue.enqueueWork(db, {
      type: 'send_manual', accountId: account.id, conversationId: firstConversation.id,
      dedupeKey: 'terminal-once', payload: { text: 'reply' },
    });
    const claimed = queue.claimNextWork(db, 'worker-a', 1_000, { types: ['send_manual'] });
    queue.markWorkExecutionStarted(db, claimed.id, claimed.workerId, claimed.claimToken, 1_500);
    const completed = queue.completeWork(db, claimed.id, { messageId: 'sent-1' }, {
      workerId: claimed.workerId, claimToken: claimed.claimToken, now: 2_000,
    });
    expect(completed.status).toBe('success');

    expect(queue.completeWork(db, work.id, { messageId: 'sent-2' }, {
      workerId: claimed.workerId, claimToken: claimed.claimToken, now: 3_000,
    }))
      .toMatchObject({ status: 'success', result: { messageId: 'sent-1' } });
    expect(queue.failWork(db, work.id, new Error('late failure'), {
      workerId: claimed.workerId, claimToken: claimed.claimToken, now: 4_000, uncertain: true,
    }))
      .toMatchObject({ status: 'success', result: { messageId: 'sent-1' } });
  });

  it.each(['send_manual', 'send_auto'])(
    'rejects completing %s before platform execution starts without changing state',
    (type) => {
      const pending = inbox.createPendingOutboundMessage(db, {
        accountId: account.id,
        conversationId: firstConversation.id,
        content: `${type} reply`,
      });
      const work = queue.enqueueWork(db, {
        type,
        accountId: account.id,
        conversationId: firstConversation.id,
        messageId: pending.message.id,
        dedupeKey: `not-started-${type}`,
        payload: { text: pending.message.content },
      });
      const claimed = queue.claimNextWork(db, 'worker-a', 1_000, { types: [type] });

      expect(() => queue.completeWork(db, work.id, { messageId: 'must-not-apply' }, {
        workerId: claimed.workerId, claimToken: claimed.claimToken, now: 2_000,
      }))
        .toThrow(/execution.*not.*started/i);
      expect(queue.getWork(db, work.id)).toMatchObject({
        status: 'running',
        executionStartedAt: null,
        result: {},
      });
      expect(inbox.getMessage(db, pending.message.id).status).toBe('pending');
    },
  );

  it('moves uncertain running work to needs_confirmation without a retry', () => {
    const work = queue.enqueueWork(db, {
      type: 'send_manual', accountId: account.id, conversationId: firstConversation.id,
      dedupeKey: 'uncertain-send', payload: { text: 'reply' },
    });
    const claimed = queue.claimNextWork(db, 'worker-a', 1_000, { types: ['send_manual'] });

    const failed = queue.failWork(db, work.id, new Error('timeout'), {
      workerId: claimed.workerId,
      claimToken: claimed.claimToken,
      now: 2_000,
      uncertain: true,
    });

    expect(failed).toMatchObject({
      status: 'needs_confirmation',
      nextRunAt: null,
      error: 'timeout',
    });
    expect(queue.claimNextWork(db, 'worker-b', 100_000, { types: ['send_manual'] })).toBeNull();
  });

  it('recovers an expired send that started platform execution as needs_confirmation', () => {
    const pending = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: firstConversation.id,
      content: 'possibly sent before crash',
    });
    const work = queue.enqueueWork(db, {
      type: 'send_manual', accountId: account.id, conversationId: firstConversation.id,
      messageId: pending.message.id, dedupeKey: 'crashed-send', payload: { text: pending.message.content },
    });
    const claimed = queue.claimNextWork(db, 'worker-a', 1_000, { types: ['send_manual'] });
    queue.markWorkExecutionStarted(db, work.id, claimed.workerId, claimed.claimToken, 2_000);

    expect(queue.recoverInterruptedWork(db, 62_000)).toBe(1);
    expect(queue.getWork(db, work.id)).toMatchObject({
      status: 'needs_confirmation',
      nextRunAt: null,
    });
    expect(inbox.getMessage(db, pending.message.id).status).toBe('needs_confirmation');
    expect(queue.claimNextWork(db, 'worker-b', 63_000, { types: ['send_manual'] })).toBeNull();
  });

  it('recovers an expired analysis commit owner without leaving the queue stuck', () => {
    const work = queue.enqueueWork(db, {
      type: 'analyze', accountId: account.id, conversationId: firstConversation.id,
      dedupeKey: 'crashed-analysis-commit', payload: {},
    });
    queue.claimNextWork(db, 'worker-a', 1_000, { types: ['analyze'] });
    db.prepare("UPDATE dm_work_items SET status='committing' WHERE id=?").run(work.id);

    expect(queue.recoverInterruptedWork(db, 62_000)).toBe(1);
    expect(queue.getWork(db, work.id)).toMatchObject({
      status: 'pending',
      workerId: null,
      leaseExpiresAt: null,
    });
    expect(queue.claimNextWork(db, 'worker-b', 63_000, { types: ['analyze'] })).toMatchObject({
      id: work.id,
      status: 'running',
      workerId: 'worker-b',
    });
  });

  it('cancels an auto reply that was claimed but has not started platform execution', () => {
    const draft = inbox.upsertReplyDraft(db, {
      accountId: account.id,
      conversationRowId: firstConversation.id,
      content: 'automatic reply',
      status: 'queued',
    });
    const pending = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: firstConversation.id,
      content: 'automatic reply',
      mode: 'auto',
    });
    const work = queue.enqueueWork(db, {
      type: 'send_auto',
      accountId: account.id,
      conversationId: firstConversation.id,
      messageId: pending.message.id,
      dedupeKey: 'claimed-auto',
      payload: { text: pending.message.content },
    });

    expect(queue.claimNextWork(db, 'auto-worker', Date.now(), { types: ['send_auto'] }).id).toBe(work.id);
    expect(queue.cancelPendingAutoReplies(db, firstConversation.id)).toBe(1);
    expect(queue.getWork(db, work.id).status).toBe('cancelled');
    expect(inbox.getMessage(db, pending.message.id).status).toBe('cancelled');
    expect(inbox.getReplyDraftByConversation(db, firstConversation.id)).toMatchObject({
      id: draft.id,
      status: 'cancelled',
    });
  });

  it('cancels every unexecuted work item for one account without touching other accounts', () => {
    const pending = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: firstConversation.id,
      content: 'pending manual reply',
    });
    const pendingSend = queue.enqueueWork(db, {
      type: 'send_manual',
      accountId: account.id,
      conversationId: firstConversation.id,
      messageId: pending.message.id,
      dedupeKey: 'account-delete-manual',
      payload: { text: pending.message.content },
    });
    const pendingAnalysis = queue.enqueueWork(db, {
      type: 'analyze',
      accountId: account.id,
      conversationId: secondConversation.id,
      dedupeKey: 'account-delete-analysis',
      payload: {},
    });
    const executionStarted = queue.enqueueWork(db, {
      type: 'send_auto',
      accountId: account.id,
      conversationId: secondConversation.id,
      dedupeKey: 'account-delete-started',
      payload: { text: 'already executing' },
    });
    db.prepare(`
      UPDATE dm_work_items
      SET status = 'running', execution_started_at = ?, worker_id = ?, claim_token = ?
      WHERE id = ?
    `).run(new Date().toISOString(), 'active-worker', 'active-token', executionStarted.id);

    const otherAccount = accounts.createAccount(db, { name: 'Account B' });
    inbox.ingestMessages(db, {
      accountId: otherAccount.id,
      messages: [{ conversation_id: 'other-conv', index: '1', sender: 'other', content: 'hello', timestamp: 3000 }],
    });
    const otherConversation = inbox.getConversationByPlatformId(db, otherAccount.id, 'other-conv');
    const otherWork = queue.enqueueWork(db, {
      type: 'analyze', accountId: otherAccount.id, conversationId: otherConversation.id,
      dedupeKey: 'other-account-analysis', payload: {},
    });

    expect(queue.cancelPendingAccountWork(db, account.id)).toBe(2);
    expect(queue.getWork(db, pendingSend.id).status).toBe('cancelled');
    expect(queue.getWork(db, pendingAnalysis.id).status).toBe('cancelled');
    expect(inbox.getMessage(db, pending.message.id).status).toBe('cancelled');
    expect(queue.getWork(db, executionStarted.id).status).toBe('running');
    expect(queue.getWork(db, otherWork.id).status).toBe('pending');
  });
});
