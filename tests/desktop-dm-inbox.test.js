const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const inbox = require('../lib/desktop/dm-inbox');
const dmLeads = require('../lib/desktop/dm-leads');
const dmWorkQueue = require('../lib/desktop/dm-work-queue');
const workspace = require('../lib/desktop/workspace');

describe('desktop dm inbox', () => {
  let dir;
  let db;
  let account;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-dm-inbox-'));
    db = openDesktopDb({ storageDir: dir });
    account = accounts.createAccount(db, { name: '账号A' });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function ingest(messages, options = {}) {
    return inbox.ingestMessages(db, {
      accountId: options.accountId || account.id,
      selfPlatformId: options.selfPlatformId,
      messages,
    });
  }

  it('stores and updates monitor state per account', () => {
    expect(inbox.getMonitorState(db, account.id)).toMatchObject({
      accountId: account.id,
      cursor: '',
      status: 'idle',
      historyStatus: 'realtime_only',
      historyIncompleteReason: null,
    });

    const updated = inbox.updateMonitorState(db, account.id, {
      cursor: 'cursor-1',
      status: 'running',
      lastError: 'timeout',
      historyStatus: 'realtime_only',
      historyIncompleteReason: '当前页面能力未验证，暂仅支持实时监听',
    });

    expect(updated).toMatchObject({
      accountId: account.id,
      cursor: 'cursor-1',
      status: 'running',
      lastError: 'timeout',
      historyStatus: 'realtime_only',
      historyIncompleteReason: '当前页面能力未验证，暂仅支持实时监听',
    });

    const secondAccount = accounts.createAccount(db, { name: '账号B' });
    expect(inbox.getMonitorState(db, secondAccount.id)).toMatchObject({
      accountId: secondAccount.id,
      cursor: '',
      status: 'idle',
      historyStatus: 'realtime_only',
      historyIncompleteReason: null,
    });

    expect(() => inbox.updateMonitorState(db, account.id, {
      historyStatus: 'complete',
    })).toThrow('historyStatus cannot be available or complete without verified history support');
  });

  it('repairs legacy unconfirmed outbound states and stale cancelled drafts on reopen', () => {
    ingest([{
      conversation_id: 'legacy-delivery-state',
      index: '1',
      sender: 'peer-legacy',
      content: 'seed',
      timestamp: 1000,
    }]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'legacy-delivery-state');
    const unconfirmed = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'legacy accepted message',
      timestamp: 2000,
    });
    inbox.updateOutboundMessageStatus(db, unconfirmed.message.id, 'sent', { message: 'OK' });

    const cancelled = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'legacy cancelled draft',
      timestamp: 3000,
    });
    inbox.upsertReplyDraft(db, {
      accountId: account.id,
      conversationRowId: conversation.id,
      content: 'legacy cancelled draft',
      status: 'queued',
    });
    dmWorkQueue.enqueueWork(db, {
      type: 'send_auto',
      accountId: account.id,
      conversationId: conversation.id,
      messageId: cancelled.message.id,
      dedupeKey: 'legacy-cancelled-auto',
      payload: { text: 'legacy cancelled draft' },
    });
    db.prepare("UPDATE dm_messages SET status = 'cancelled' WHERE id = ?").run(cancelled.message.id);
    db.prepare("UPDATE dm_work_items SET status = 'cancelled' WHERE message_id = ?").run(cancelled.message.id);

    db.close();
    db = openDesktopDb({ storageDir: dir });

    expect(inbox.getMessage(db, unconfirmed.message.id).status).toBe('accepted');
    expect(inbox.getReplyDraftByConversation(db, conversation.id).status).toBe('cancelled');
  });

  it('syncs messages sent outside Vulcan as outbound in new conversations', () => {
    inbox.updateMonitorState(db, account.id, { platformUserId: 'self-100' });

    const outbound = ingest([{
      conversation_id: '0:1:peer-200:self-100',
      index: '1',
      sender: 'self-100',
      content: 'sent from the Douyin app',
      timestamp: 1000,
    }]);

    expect(outbound).toMatchObject({ inserted: 1, reconciled: 0 });
    const conversation = inbox.getConversationByPlatformId(db, account.id, '0:1:peer-200:self-100');
    expect(conversation).toMatchObject({ peerId: 'peer-200', unreadCount: 0 });
    expect(inbox.listMessages(db, conversation.id)).toEqual([
      expect.objectContaining({
        sender: 'self-100',
        direction: 'outbound',
        status: 'sent',
        content: 'sent from the Douyin app',
      }),
    ]);

    ingest([{
      conversation_id: '0:1:peer-200:self-100',
      index: '2',
      sender: 'peer-200',
      content: 'reply from peer',
      timestamp: 2000,
    }]);
    expect(inbox.listMessages(db, conversation.id).at(-1)).toMatchObject({
      sender: 'peer-200',
      direction: 'inbound',
    });
  });

  it('repairs previously misclassified external outbound messages after learning the account uid', () => {
    ingest([{
      conversation_id: '0:1:peer-300:self-300',
      index: '1',
      sender: 'self-300',
      content: 'old external outbound',
      timestamp: 1000,
    }]);
    let conversation = inbox.getConversationByPlatformId(db, account.id, '0:1:peer-300:self-300');
    expect(conversation.peerId).toBe('self-300');
    expect(inbox.listMessages(db, conversation.id)[0].direction).toBe('inbound');

    ingest([{
      conversation_id: '0:1:peer-300:self-300',
      index: '2',
      sender: 'peer-300',
      content: 'new inbound',
      timestamp: 2000,
    }], { selfPlatformId: 'self-300' });

    conversation = inbox.getConversationByPlatformId(db, account.id, '0:1:peer-300:self-300');
    expect(conversation.peerId).toBe('peer-300');
    expect(inbox.getMonitorState(db, account.id).platformUserId).toBe('self-300');
    expect(inbox.listMessages(db, conversation.id)).toEqual([
      expect.objectContaining({ sender: 'self-300', direction: 'outbound', status: 'sent' }),
      expect.objectContaining({ sender: 'peer-300', direction: 'inbound', status: 'received' }),
    ]);
  });

  it('does not rewrite monitor identity when the supplied Douyin uid is unchanged', () => {
    inbox.updateMonitorState(db, account.id, { platformUserId: 'self-stable' });
    db.prepare(`UPDATE dm_monitor_states SET updated_at = '2020-01-01T00:00:00.000Z' WHERE account_id = ?`)
      .run(account.id);

    ingest([], { selfPlatformId: 'self-stable' });

    expect(db.prepare('SELECT updated_at FROM dm_monitor_states WHERE account_id = ?').get(account.id))
      .toEqual({ updated_at: '2020-01-01T00:00:00.000Z' });
  });

  it('deduplicates the same platform message and updates unread state once', () => {
    const first = ingest([
      {
        conversation_id: 'c1',
        index: '8',
        sender: 'user-1',
        content: '怎么收费？',
        timestamp: 1000,
        conversation_name: '张三',
      },
    ]);
    const second = ingest([
      {
        conversation_id: 'c1',
        index: '8',
        sender: 'user-1',
        content: '怎么收费？',
        timestamp: 1000,
        conversation_name: '张三',
      },
    ]);

    expect(first.inserted).toBe(1);
    expect(first.duplicates).toBe(0);
    expect(first.insertedMessages).toHaveLength(1);
    expect(first.insertedMessages[0]).toMatchObject({
      accountId: account.id,
      peerName: '张三',
      content: '怎么收费？',
    });

    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(1);

    const conversation = inbox.listConversations(db, { accountId: account.id })[0];
    expect(inbox.listMessages(db, conversation.id)).toHaveLength(1);
    expect(conversation.unreadCount).toBe(1);
    expect(first.insertedMessages[0].conversationId).toBe(conversation.id);
  });

  it('reconciles a known non-peer websocket echo with the local outbound message', () => {
    ingest([{
      conversation_id: 'c-echo',
      index: '1',
      sender: 'peer-1',
      content: 'incoming seed',
      timestamp: 1000,
    }]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c-echo');
    inbox.markConversationRead(db, conversation.id);
    const pending = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'same outbound text',
      timestamp: 2000,
    });
    inbox.updateOutboundMessageStatus(db, pending.message.id, 'accepted');
    expect(inbox.getMessage(db, pending.message.id).status).toBe('accepted');

    const result = ingest([{
      conversation_id: 'c-echo',
      index: '2',
      sender: 'self-platform-id',
      content: 'same outbound text',
      timestamp: 2100,
    }]);

    expect(result).toMatchObject({ inserted: 0, duplicates: 0, reconciled: 1 });
    const messages = inbox.listMessages(db, conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: pending.message.id,
      direction: 'outbound',
      status: 'sent',
      messageKey: 'index:2',
      sender: 'self-platform-id',
    });
    expect(inbox.getConversation(db, conversation.id)).toMatchObject({
      unreadCount: 0,
      lastMessageId: pending.message.id,
      lastMessageText: 'same outbound text',
    });
  });

  it('reconciles identical outbound echoes one-to-one and keeps peer messages inbound', () => {
    ingest([{
      conversation_id: 'c-repeat-echo',
      index: '1',
      sender: 'peer-repeat',
      content: 'seed',
      timestamp: 1000,
    }]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c-repeat-echo');
    const first = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'repeat',
      timestamp: 2000,
    });
    const second = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'repeat',
      timestamp: 2200,
    });
    inbox.updateOutboundMessageStatus(db, first.message.id, 'sent');
    inbox.updateOutboundMessageStatus(db, second.message.id, 'sent');

    expect(ingest([{
      conversation_id: 'c-repeat-echo', index: '2', sender: 'self-id', content: 'repeat', timestamp: 2050,
    }]).reconciled).toBe(1);
    expect(ingest([{
      conversation_id: 'c-repeat-echo', index: '3', sender: 'self-id', content: 'repeat', timestamp: 2250,
    }]).reconciled).toBe(1);
    expect(ingest([{
      conversation_id: 'c-repeat-echo', index: '4', sender: 'peer-repeat', content: 'repeat', timestamp: 2300,
    }])).toMatchObject({ inserted: 1, reconciled: 0 });

    const messages = inbox.listMessages(db, conversation.id);
    expect(messages).toHaveLength(4);
    expect(messages.find((message) => message.id === first.message.id)).toMatchObject({ messageKey: 'index:2', direction: 'outbound' });
    expect(messages.find((message) => message.id === second.message.id)).toMatchObject({ messageKey: 'index:3', direction: 'outbound' });
    expect(messages.at(-1)).toMatchObject({ messageKey: 'index:4', direction: 'inbound', sender: 'peer-repeat' });
  });

  it('reconciles pending messages only after their send work has started executing', () => {
    ingest([{
      conversation_id: 'c-execution-guard', index: '1', sender: 'peer-guard', content: 'seed', timestamp: 1000,
    }]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c-execution-guard');
    inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'queued but not sent',
      timestamp: 2000,
    });

    expect(ingest([{
      conversation_id: 'c-execution-guard', index: '2', sender: 'self-id', content: 'queued but not sent', timestamp: 2050,
    }])).toMatchObject({ inserted: 1, reconciled: 0 });

    const executing = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'executing now',
      timestamp: 3000,
    });
    dmWorkQueue.enqueueWork(db, {
      type: 'send_manual',
      accountId: account.id,
      conversationId: conversation.id,
      messageId: executing.message.id,
      dedupeKey: 'execution-guard',
      payload: { text: 'executing now' },
    });
    const claimed = dmWorkQueue.claimNextWork(db, 'echo-test-worker', Date.now());
    dmWorkQueue.markWorkExecutionStarted(db, claimed.id, 'echo-test-worker', claimed.claimToken);

    expect(ingest([{
      conversation_id: 'c-execution-guard', index: '3', sender: 'self-id', content: 'executing now', timestamp: 3050,
    }])).toMatchObject({ inserted: 0, reconciled: 1 });
  });

  it('skips read badges and other system command notifications before creating conversations', () => {
    const result = ingest([
      {
        conversation_id: 'c-system',
        index: '7',
        sender: 'user-1',
        message_type: 7,
        content: JSON.stringify({ command_type: 14, read_badge_count: 6 }),
      },
      {
        conversation_id: 'c-receipt',
        index: '8',
        sender: 'user-1',
        message_type: 50001,
        content: JSON.stringify({ read_index: 7 }),
      },
      {
        conversation_id: 'c-user',
        index: '9',
        sender: 'user-1',
        message_type: 7,
        content: '1',
      },
    ]);

    expect(result).toMatchObject({ inserted: 1, duplicates: 0, skipped: 2 });
    expect(inbox.listConversations(db, { accountId: account.id })).toHaveLength(1);
    expect(inbox.listConversations(db, { accountId: account.id })[0].conversationId).toBe('c-user');
  });

  it('resolves a sender nickname from locally synced comments', () => {
    workspace.upsertVideo(db, {
      awemeId: 'video-known-user',
      accountId: account.id,
      source: 'my_posts',
    });
    workspace.upsertComment(db, {
      cid: 'comment-known-user',
      awemeId: 'video-known-user',
      accountId: account.id,
      userId: '99723040126',
      userName: '阿k桑',
      text: '你好',
    });

    ingest([{
      conversation_id: 'c-known-user',
      index: '1',
      sender: '99723040126',
      message_type: 7,
      content: '1',
      timestamp: 1000,
    }]);

    expect(inbox.getConversationByPlatformId(db, account.id, 'c-known-user').peerName).toBe('阿k桑');
  });

  it('backfills missing conversation names after local user data becomes available', () => {
    ingest([{
      conversation_id: 'c-backfill-user',
      index: '1',
      sender: 'known-after-ingest',
      message_type: 7,
      content: '1',
      timestamp: 1000,
    }]);
    workspace.upsertVideo(db, {
      awemeId: 'video-backfill-user',
      accountId: account.id,
      source: 'my_posts',
    });
    workspace.upsertComment(db, {
      cid: 'comment-backfill-user',
      awemeId: 'video-backfill-user',
      accountId: account.id,
      userId: 'known-after-ingest',
      userName: '本地昵称',
      text: '咨询',
    });

    expect(inbox.backfillConversationPeerNames(db)).toBe(1);
    expect(inbox.getConversationByPlatformId(db, account.id, 'c-backfill-user').peerName).toBe('本地昵称');
  });

  it('purges previously stored system notifications without deleting real messages', () => {
    ingest([{
      conversation_id: 'c-live',
      index: '7',
      sender: 'user-1',
      message_type: 7,
      content: '1',
      timestamp: 1000,
    }]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c-live');
    const timestamp = new Date().toISOString();
    const systemContent = JSON.stringify({
      command_type: 14,
      conversation_id: 'c-live',
      read_badge_count: 6,
      read_index: 1672502400080000,
    });
    db.prepare(`
      INSERT INTO dm_messages (
        id, account_id, conversation_row_id, conversation_id, message_key,
        sender, message_type, direction, status, content, timestamp_ms, raw, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'dmm_system_notification',
      account.id,
      conversation.id,
      'c-live',
      'index:8',
      'user-1',
      '50001',
      'inbound',
      'received',
      systemContent,
      2000,
      JSON.stringify({ message_type: 50001, content: systemContent }),
      timestamp,
      timestamp,
    );
    db.prepare(`
      UPDATE dm_conversations
      SET last_message_id = ?, last_message_key = ?, last_message_text = ?,
          last_message_at = ?, unread_count = 2
      WHERE id = ?
    `).run('dmm_system_notification', 'index:8', systemContent, 2000, conversation.id);

    const result = inbox.purgeSystemNotifications(db);

    expect(result).toMatchObject({ removed: 1, updatedConversations: 1, removedConversations: 0 });
    expect(inbox.listMessages(db, conversation.id).map((message) => message.content)).toEqual(['1']);
    expect(inbox.getConversation(db, conversation.id)).toMatchObject({
      lastMessageText: '1',
      unreadCount: 1,
    });
  });

  it('uses a hash key fallback when platform message index is missing', () => {
    const first = ingest([
      {
        conversation_id: 'c1',
        sender: 'user-1',
        content: '你好',
        message_type: 'text',
        timestamp: 15000,
      },
    ]);
    const second = ingest([
      {
        conversation_id: 'c1',
        sender: 'user-1',
        content: '你好',
        message_type: 'text',
        timestamp: 20000,
      },
    ]);
    const third = ingest([
      {
        conversation_id: 'c1',
        sender: 'user-1',
        content: '你好',
        message_type: 'text',
        timestamp: 45000,
      },
    ]);

    expect(first.inserted).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(third.inserted).toBe(1);

    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c1');
    expect(inbox.listMessages(db, conversation.id)).toHaveLength(2);
    expect(inbox.getConversation(db, conversation.id).unreadCount).toBe(2);
  });

  it('treats numeric index zero as a valid platform message key', () => {
    expect(inbox.messageKey({
      conversation_id: 'c1',
      index: 0,
      sender: 'user-1',
      content: 'zero',
      timestamp: 1000,
    })).toBe('index:0');

    expect(inbox.messageKey({
      conversation_id: 'c1',
      message_index: 0,
      sender: 'user-1',
      content: 'zero',
      timestamp: 1000,
    })).toBe('index:0');
  });

  it('keeps conversations isolated per account and lists them in a stable order', () => {
    const secondAccount = accounts.createAccount(db, { name: '账号B' });
    ingest([
      {
        conversation_id: 'conv-b',
        index: '1',
        sender: 'user-b',
        content: 'second',
        timestamp: 3000,
        conversation_name: '李四',
      },
      {
        conversation_id: 'conv-a',
        index: '1',
        sender: 'user-a',
        content: 'first',
        timestamp: 3000,
        conversation_name: '王五',
      },
    ]);
    ingest([
      {
        conversation_id: 'conv-a',
        index: '9',
        sender: 'user-a',
        content: 'other account',
        timestamp: 5000,
        conversation_name: '王五',
      },
    ], { accountId: secondAccount.id });

    expect(inbox.listConversations(db, { accountId: account.id }).map((item) => item.conversationId))
      .toEqual(['conv-a', 'conv-b']);
    expect(inbox.listConversations(db, { accountId: secondAccount.id }).map((item) => item.conversationId))
      .toEqual(['conv-a']);
    expect(inbox.getConversationByPlatformId(db, account.id, 'conv-a').accountId).toBe(account.id);
    expect(inbox.getConversationByPlatformId(db, secondAccount.id, 'conv-a').accountId).toBe(secondAccount.id);
  });

  it('returns the latest linked source comment without exposing raw comment metadata', () => {
    workspace.upsertVideo(db, { awemeId: 'video-1', accountId: account.id, source: 'search' });
    workspace.upsertComment(db, {
      cid: 'comment-1',
      awemeId: 'video-1',
      accountId: account.id,
      userId: 'user-1',
      userName: '客户甲',
      text: '请问这个服务怎么收费？',
      raw: { secret: 'must-not-leak' },
    });
    dmLeads.syncLeadsFromComments(db, { accountId: account.id, awemeId: 'video-1' });
    const lead = dmLeads.listLeads(db, { accountId: account.id })[0];
    dmLeads.markLeadSent(db, lead.id, { conversationId: 'source-conversation' });
    ingest([{
      conversation_id: 'source-conversation',
      index: '1',
      sender: 'user-1',
      content: '你好',
      timestamp: 1000,
      conversation_name: '客户甲',
    }]);

    const exact = inbox.getConversationByPlatformId(db, account.id, 'source-conversation');
    const listed = inbox.listConversations(db, { accountId: account.id });
    expect(exact.sourceComment).toBe('请问这个服务怎么收费？');
    expect(listed[0].sourceComment).toBe('请问这个服务怎么收费？');
    expect(exact).not.toHaveProperty('raw');
    expect(JSON.stringify(exact)).not.toContain('must-not-leak');
  });

  it('marks a conversation read and keeps message ordering stable', () => {
    ingest([
      {
        conversation_id: 'c1',
        index: '2',
        sender: 'user-1',
        content: '第二条',
        timestamp: 4000,
      },
      {
        conversation_id: 'c1',
        index: '1',
        sender: 'user-1',
        content: '第一条',
        timestamp: 4000,
      },
    ]);

    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c1');
    expect(inbox.listMessages(db, conversation.id).map((item) => item.content)).toEqual(['第一条', '第二条']);

    const read = inbox.markConversationRead(db, conversation.id);
    expect(read.unreadCount).toBe(0);
    expect(read.lastReadAt).toBeTruthy();
  });

  it('sorts numeric message indexes in ascending order when timestamps tie', () => {
    ingest([
      {
        conversation_id: 'c1',
        index: '10',
        sender: 'user-1',
        content: '第十条',
        timestamp: 5000,
      },
      {
        conversation_id: 'c1',
        index: '2',
        sender: 'user-1',
        content: '第二条',
        timestamp: 5000,
      },
      {
        conversation_id: 'c1',
        index: '1',
        sender: 'user-1',
        content: '第一条',
        timestamp: 5000,
      },
    ]);

    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c1');
    expect(inbox.listMessages(db, conversation.id).map((item) => item.content))
      .toEqual(['第一条', '第二条', '第十条']);
  });

  it('rejects listing conversations without an account id', () => {
    expect(() => inbox.listConversations(db)).toThrow(/accountId is required/);
    expect(() => inbox.listConversations(db, {})).toThrow(/accountId is required/);
  });

  it('updates conversations, upserts reply drafts, and consumes auto reply authorization once', () => {
    ingest([
      {
        conversation_id: 'c1',
        index: '1',
        sender: 'user-1',
        content: '你好',
        timestamp: 1000,
        conversation_name: '张三',
      },
    ]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c1');

    const updated = inbox.updateConversation(db, conversation.id, {
      status: 'closed',
      peerName: '新名字',
      autoReplyEnabled: true,
    });
    expect(updated).toMatchObject({
      id: conversation.id,
      status: 'closed',
      peerName: '新名字',
      autoReplyEnabled: true,
    });

    const firstDraft = inbox.upsertReplyDraft(db, {
      conversationRowId: conversation.id,
      accountId: account.id,
      content: '自动回复草稿',
      status: 'draft',
      meta: { source: 'analysis' },
    });
    const secondDraft = inbox.upsertReplyDraft(db, {
      conversationRowId: conversation.id,
      accountId: account.id,
      content: '更新后的草稿',
      status: 'approved',
      meta: { source: 'manual' },
    });

    expect(secondDraft.id).toBe(firstDraft.id);
    expect(secondDraft.content).toBe('更新后的草稿');
    expect(secondDraft.status).toBe('approved');
    expect(secondDraft.meta).toEqual({ source: 'manual' });

    const firstConsume = inbox.consumeAutoReplyAuthorization(db, conversation.id, { messageId: 'm1' });
    const secondConsume = inbox.consumeAutoReplyAuthorization(db, conversation.id, { messageId: 'm2' });

    expect(firstConsume).toMatchObject({
      consumed: true,
      workItem: {
        accountId: account.id,
        conversationRowId: conversation.id,
        messageId: 'm1',
      },
    });
    expect(secondConsume).toMatchObject({
      consumed: false,
      reason: 'authorization_required',
    });

    inbox.reauthorizeAutoReply(db, conversation.id);

    expect(inbox.consumeAutoReplyAuthorization(db, conversation.id, { messageId: 'm2' })).toMatchObject({
      consumed: true,
      workItem: {
        messageId: 'm2',
      },
    });
  });

  it('returns the same work item when auto reply consumption is retried with the same message id', () => {
    ingest([
      {
        conversation_id: 'c1',
        index: '1',
        sender: 'user-1',
        content: '你好',
        timestamp: 1000,
      },
    ]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c1');

    const first = inbox.consumeAutoReplyAuthorization(db, conversation.id, { messageId: 'm1' });
    const retry = inbox.consumeAutoReplyAuthorization(db, conversation.id, { messageId: 'm1' });
    const next = inbox.consumeAutoReplyAuthorization(db, conversation.id, { messageId: 'm2' });

    expect(first.consumed).toBe(true);
    expect(retry).toMatchObject({
      consumed: true,
      workItem: {
        id: first.workItem.id,
        messageId: 'm1',
      },
    });
    expect(next).toMatchObject({
      consumed: false,
      reason: 'authorization_required',
    });
  });

  it('accepts only supported replyModeOverride values when conversations are updated directly', () => {
    ingest([
      {
        conversation_id: 'c1',
        index: '1',
        sender: 'user-1',
        content: '浣犲ソ',
        timestamp: 1000,
      },
    ]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c1');

    expect(inbox.updateConversation(db, conversation.id, { replyModeOverride: 'manual' }).replyModeOverride).toBe('manual');
    expect(inbox.updateConversation(db, conversation.id, { replyModeOverride: 'tiered' }).replyModeOverride).toBe('tiered');
    expect(inbox.updateConversation(db, conversation.id, { replyModeOverride: 'automatic' }).replyModeOverride).toBe('automatic');
    expect(inbox.updateConversation(db, conversation.id, { replyModeOverride: null }).replyModeOverride).toBeNull();

    expect(() => inbox.updateConversation(db, conversation.id, { replyModeOverride: 'robot' }))
      .toThrow(/replyModeOverride/i);
    expect(() => inbox.updateConversation(db, conversation.id, { replyModeOverride: true }))
      .toThrow(/replyModeOverride/i);
    expect(() => inbox.updateConversation(db, conversation.id, { replyModeOverride: ' manual ' }))
      .toThrow(/replyModeOverride/i);
    expect(() => inbox.updateConversation(db, conversation.id, { replyModeOverride: 'manual\n' }))
      .toThrow(/replyModeOverride/i);
    expect(() => inbox.updateConversation(db, conversation.id, { replyModeOverride: '' }))
      .toThrow(/replyModeOverride/i);

    expect(inbox.getConversation(db, conversation.id).replyModeOverride).toBeNull();
  });

  it('deletes a conversation and its local dependent records after send work is terminal', () => {
    ingest([{
      conversation_id: 'c-local-delete', index: '1', sender: 'peer-delete', content: 'hello', timestamp: 1000,
    }]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c-local-delete');
    const outbound = inbox.createPendingOutboundMessage(db, {
      accountId: account.id,
      conversationId: conversation.id,
      content: 'reply',
      timestamp: 2000,
    });
    inbox.upsertReplyDraft(db, {
      accountId: account.id,
      conversationRowId: conversation.id,
      content: 'draft',
      status: 'needs_review',
    });
    const work = dmWorkQueue.enqueueWork(db, {
      type: 'send_manual',
      accountId: account.id,
      conversationId: conversation.id,
      messageId: outbound.message.id,
      dedupeKey: 'local-delete-send',
      payload: { text: 'reply' },
    });

    expect(() => inbox.deleteConversationLocal(db, conversation.id, account.id)).toThrow(/sending/i);
    db.prepare("UPDATE dm_work_items SET status = 'success' WHERE id = ?").run(work.id);

    expect(inbox.deleteConversationLocal(db, conversation.id, account.id)).toEqual({
      id: conversation.id,
      deleted: true,
    });
    expect(inbox.getConversation(db, conversation.id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM dm_messages WHERE conversation_row_id = ?').get(conversation.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dm_reply_drafts WHERE conversation_row_id = ?').get(conversation.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dm_work_items WHERE conversation_row_id = ?').get(conversation.id).count).toBe(0);
  });

  it('does not locally delete a conversation owned by another account', () => {
    ingest([{
      conversation_id: 'c-owned', index: '1', sender: 'peer-owned', content: 'hello', timestamp: 1000,
    }]);
    const conversation = inbox.getConversationByPlatformId(db, account.id, 'c-owned');
    const otherAccount = accounts.createAccount(db, { name: 'Other account' });

    expect(inbox.deleteConversationLocal(db, conversation.id, otherAccount.id)).toBeNull();
    expect(inbox.getConversation(db, conversation.id)).not.toBeNull();
  });
});
