const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { openDesktopDb } = require('../lib/desktop/db');
const accounts = require('../lib/desktop/accounts');
const inbox = require('../lib/desktop/dm-inbox');
const {
  HISTORY_REASON_MAX_LENGTH,
  normalizeHistoryPage,
} = require('../lib/desktop/dm-history');

const REALTIME_ONLY_REASON = '当前页面能力未验证，暂仅支持实时监听';

function extractSection(source, startMarker, endMarker) {
  const start = source.lastIndexOf(startMarker);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Missing end marker after: ${startMarker}`);
  return source.slice(start, end).trimEnd();
}

function loadHistoryBridge() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'douyin.user.js'), 'utf8');
  const historyBlock = extractSection(
    source,
    '  getDMHistoryCapabilities: function(){',
    '  connectDMWS: async function(){',
  );
  let networkCalls = 0;
  const context = {
    fetch() {
      networkCalls += 1;
      throw new Error('history fallback must not use network');
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(`window.__bridge = {\n${historyBlock}\n};`, context);
  return {
    bridge: context.window.__bridge,
    getNetworkCalls: () => networkCalls,
  };
}

describe('DM history capability fallback', () => {
  it('normalizes unsupported pages without retaining messages, cursor, or pagination', () => {
    expect(normalizeHistoryPage({
      supported: false,
      reason: '端点未验证',
      messages: [{ content: '不应保留' }],
      next_cursor: 'secret-cursor',
      has_more: true,
    })).toEqual({
      supported: false,
      messages: [],
      nextCursor: null,
      hasMore: false,
      incompleteReason: '端点未验证',
    });
  });

  it.each([
    null,
    [],
    {},
    { supported: true, messages: 'invalid', has_more: false },
    { supported: true, messages: [], has_more: true, next_cursor: '' },
  ])('treats malformed history input as safe unsupported data: %j', (value) => {
    const result = normalizeHistoryPage(value);
    expect(result).toMatchObject({
      supported: false,
      messages: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(result.incompleteReason).toEqual(expect.any(String));
    expect(result.incompleteReason.length).toBeGreaterThan(0);
  });

  it('removes control characters and safely crops untrusted reasons', () => {
    const result = normalizeHistoryPage({
      supported: false,
      reason: `\u0000\u0007${'历史能力未验证'.repeat(100)}`,
    });

    expect(result.incompleteReason).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(result.incompleteReason.length).toBeLessThanOrEqual(HISTORY_REASON_MAX_LENGTH);
  });

  it('keeps a future verified normalized page contract and deduplicates realtime messages', () => {
    const page = normalizeHistoryPage({
      supported: true,
      messages: [
        { conversation_id: 'conv-1', index: '8', sender: 'peer-1', content: '历史消息', timestamp: 8 },
        { conversation_id: 'conv-1', index: '9', sender: 'peer-1', content: '实时消息', timestamp: 9 },
      ],
      next_cursor: '9',
      has_more: true,
    });
    expect(page).toMatchObject({ supported: true, nextCursor: '9', hasMore: true, incompleteReason: null });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-dm-history-'));
    const db = openDesktopDb({ storageDir: dir });
    try {
      const account = accounts.createAccount(db, { name: '账号A' });
      inbox.ingestMessages(db, { accountId: account.id, messages: [page.messages[1]] });
      const ingested = inbox.ingestMessages(db, { accountId: account.id, messages: page.messages });
      expect(ingested).toMatchObject({ inserted: 1, duplicates: 1 });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes stable unsupported capability and sync results without any network request', async () => {
    const runtime = loadHistoryBridge();

    expect(runtime.bridge.getDMHistoryCapabilities()).toEqual({
      supported: false,
      reason: REALTIME_ONLY_REASON,
    });
    await expect(runtime.bridge.syncDMHistory({ conversationId: 'conv-1', cursor: null, limit: 50 }))
      .resolves.toEqual({
        supported: false,
        messages: [],
        next_cursor: null,
        has_more: false,
        reason: REALTIME_ONLY_REASON,
      });
    expect(runtime.getNetworkCalls()).toBe(0);
  });
});
