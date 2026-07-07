const { idWithPrefix, nowIso, parseJson, stringifyJson } = require('./serialize');

function mapAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    group: row.group_name,
    profileKey: row.profile_key,
    proxyConfig: parseJson(row.proxy_config, {}),
    status: row.status,
    lastSeenAt: row.last_seen_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getAccount(db, id) {
  return mapAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
}

function createAccount(db, input = {}) {
  const id = input.id || idWithPrefix('acct');
  const timestamp = nowIso();
  const account = {
    id,
    name: String(input.name || '').trim() || 'Untitled Account',
    group: input.group || '',
    profileKey: input.profileKey || id,
    proxyConfig: input.proxyConfig || {},
    status: input.status || 'login_required',
    lastSeenAt: input.lastSeenAt || null,
    notes: input.notes || '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  db.prepare(`
    INSERT INTO accounts (
      id, name, group_name, profile_key, proxy_config, status,
      last_seen_at, notes, created_at, updated_at
    ) VALUES (
      @id, @name, @groupName, @profileKey, @proxyConfig, @status,
      @lastSeenAt, @notes, @createdAt, @updatedAt
    )
  `).run({
    id: account.id,
    name: account.name,
    groupName: account.group,
    profileKey: account.profileKey,
    proxyConfig: stringifyJson(account.proxyConfig),
    status: account.status,
    lastSeenAt: account.lastSeenAt,
    notes: account.notes,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  });

  return getAccount(db, id);
}

function listAccounts(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all().map(mapAccount);
}

function updateAccount(db, id, patch = {}) {
  const existing = getAccount(db, id);
  if (!existing) return null;

  const next = {
    name: patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name,
    group: patch.group !== undefined ? patch.group : existing.group,
    profileKey: patch.profileKey !== undefined ? patch.profileKey : existing.profileKey,
    proxyConfig: patch.proxyConfig !== undefined ? patch.proxyConfig : existing.proxyConfig,
    status: patch.status !== undefined ? patch.status : existing.status,
    lastSeenAt: patch.lastSeenAt !== undefined ? patch.lastSeenAt : existing.lastSeenAt,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    updatedAt: nowIso(),
  };

  db.prepare(`
    UPDATE accounts
    SET name = @name,
        group_name = @groupName,
        profile_key = @profileKey,
        proxy_config = @proxyConfig,
        status = @status,
        last_seen_at = @lastSeenAt,
        notes = @notes,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    name: next.name,
    groupName: next.group,
    profileKey: next.profileKey,
    proxyConfig: stringifyJson(next.proxyConfig),
    status: next.status,
    lastSeenAt: next.lastSeenAt,
    notes: next.notes,
    updatedAt: next.updatedAt,
  });

  return getAccount(db, id);
}

function deleteAccount(db, id) {
  return db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
};
