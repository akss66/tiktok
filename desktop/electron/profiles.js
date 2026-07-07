function partitionForAccount(account) {
  return `persist:douyin-account-${account.profileKey || account.id}`;
}

module.exports = { partitionForAccount };
