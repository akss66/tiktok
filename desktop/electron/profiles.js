function partitionForAccount(account) {
  const accountId = String(account?.id || '').trim();
  const profileKey = String(account?.profileKey || '').trim();
  const stableKey = accountId || profileKey;
  return `persist:douyin-account-${stableKey}`;
}

module.exports = { partitionForAccount };
