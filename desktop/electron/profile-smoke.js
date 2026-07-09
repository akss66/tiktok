const assert = require('assert');
const { partitionForAccount } = require('./profiles');

function accountA() {
  return { id: 'acct_profile_smoke_a', profileKey: 'acct_profile_smoke_a' };
}

function accountB() {
  return { id: 'acct_profile_smoke_b', profileKey: 'acct_profile_smoke_b' };
}

function accountBWithSameProfileKey() {
  return { id: 'acct_profile_smoke_b', profileKey: 'acct_profile_smoke_a' };
}

const partitionA = partitionForAccount(accountA());
const partitionB = partitionForAccount(accountB());
const partitionSameProfileKeyB = partitionForAccount(accountBWithSameProfileKey());

assert.notStrictEqual(partitionA, partitionB, 'account partitions must differ');
assert.notStrictEqual(partitionA, partitionSameProfileKeyB, 'account id must keep partitions isolated even if profileKey collides');
assert.ok(partitionA.startsWith('persist:douyin-account-'), 'account partition should use persistent account namespace');
assert.ok(partitionB.startsWith('persist:douyin-account-'), 'account partition should use persistent account namespace');

console.log('Profile smoke test passed: account partitions are isolated and persistent.');
