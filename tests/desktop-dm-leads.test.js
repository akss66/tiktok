const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const workspace = require('../lib/desktop/workspace');
const dmLeads = require('../lib/desktop/dm-leads');

describe('desktop dm leads', () => {
  let dir;
  let db;
  let account;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-dm-leads-'));
    db = openDesktopDb({ storageDir: dir });
    account = accounts.createAccount(db, { name: '账号A' });
    workspace.upsertVideo(db, { awemeId: 'video-1', accountId: account.id, source: 'search' });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function saveComment(cid, userId, text, userName = '访客', options = {}) {
    return workspace.upsertComment(db, {
      cid,
      awemeId: options.awemeId || 'video-1',
      accountId: options.accountId || account.id,
      userId,
      userName,
      text,
    });
  }

  it('deduplicates leads by sender account and target user', () => {
    saveComment('comment-1', 'user-1', '怎么收费？', '张三');
    saveComment('comment-2', 'user-1', '可以合作吗？', '张三');

    const result = dmLeads.syncLeadsFromComments(db, {
      accountId: account.id,
      awemeId: 'video-1',
    });

    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(dmLeads.listLeads(db, { accountId: account.id })).toHaveLength(1);
  });

  it('keeps every source comment while deduplicating per sender account', () => {
    workspace.upsertVideo(db, { awemeId: 'video-2', accountId: account.id, source: 'search' });
    saveComment('comment-a', 'same-user', 'A 视频下询价', '客户甲');
    saveComment('comment-b', 'same-user', 'B 视频下问合作', '客户甲', { awemeId: 'video-2' });

    dmLeads.syncLeadsFromComments(db, { accountId: account.id });
    const lead = dmLeads.listLeads(db, { accountId: account.id })[0];
    expect(dmLeads.listLeads(db, { accountId: account.id })).toHaveLength(1);
    expect(dmLeads.listLeadSources(db, lead.id).map((item) => item.commentId).sort())
      .toEqual(['comment-a', 'comment-b']);
    expect(dmLeads.listLeads(db, { accountId: account.id, query: 'A 视频下询价' }))
      .toHaveLength(1);

    dmLeads.markLeadSent(db, lead.id, { conversationId: 'conv-1' });
    saveComment('comment-c', 'same-user', '再次咨询', '客户甲', { awemeId: 'video-2' });
    dmLeads.syncLeadsFromComments(db, { accountId: account.id });
    expect(dmLeads.getLead(db, lead.id).status).toBe('sent');
    expect(dmLeads.listLeadSources(db, lead.id)).toHaveLength(3);

    const secondAccount = accounts.createAccount(db, { name: '账号B' });
    workspace.upsertVideo(db, { awemeId: 'video-3', accountId: secondAccount.id, source: 'search' });
    saveComment('comment-d', 'same-user', '给账号B的评论', '客户甲', {
      awemeId: 'video-3', accountId: secondAccount.id,
    });
    dmLeads.syncLeadsFromComments(db, { accountId: secondAccount.id });
    expect(dmLeads.listLeads(db, { accountId: secondAccount.id })).toHaveLength(1);
  });

  it('stores analysis, requires approval, and protects sent leads', () => {
    saveComment('comment-1', 'user-1', '怎么收费？', '张三');
    dmLeads.syncLeadsFromComments(db, { accountId: account.id, awemeId: 'video-1' });
    const lead = dmLeads.listLeads(db, { accountId: account.id })[0];

    const analyzed = dmLeads.updateLead(db, lead.id, {
      intentLevel: 'high',
      reason: '明确询价',
      draftText: '你好，看到你在评论区咨询收费。',
      status: 'draft',
    });
    expect(analyzed.intentLevel).toBe('high');
    expect(analyzed.status).toBe('draft');

    expect(() => dmLeads.assertSendable(analyzed)).toThrow(/审核/);
    const approved = dmLeads.updateLead(db, lead.id, { status: 'approved' });
    expect(dmLeads.assertSendable(approved)).toBe(true);

    const sent = dmLeads.markLeadSent(db, lead.id, {
      conversationId: 'conversation-1',
      messageId: 'message-1',
    });
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).toBeTruthy();
    expect(() => dmLeads.assertSendable(sent)).toThrow(/已发送/);
  });

  it('filters leads by keyword, intent, and status', () => {
    saveComment('comment-1', 'user-1', '怎么收费？', '张三');
    saveComment('comment-2', 'user-2', '路过看看', '李四');
    dmLeads.syncLeadsFromComments(db, { accountId: account.id, awemeId: 'video-1' });
    const leads = dmLeads.listLeads(db, { accountId: account.id });
    dmLeads.updateLead(db, leads.find((item) => item.userId === 'user-1').id, {
      intentLevel: 'high', status: 'approved', draftText: '你好',
    });

    expect(dmLeads.listLeads(db, { accountId: account.id, query: '张三' })).toHaveLength(1);
    expect(dmLeads.listLeads(db, { accountId: account.id, query: '路过' })).toHaveLength(1);
    expect(dmLeads.listLeads(db, { accountId: account.id, intentLevel: 'high' })).toHaveLength(1);
    expect(dmLeads.listLeads(db, { accountId: account.id, status: 'approved' })).toHaveLength(1);
  });
});
