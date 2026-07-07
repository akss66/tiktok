function nowIso() {
  return new Date().toISOString();
}

function idWithPrefix(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value) {
  return JSON.stringify(value === undefined ? {} : value);
}

const crypto = require('crypto');

module.exports = {
  idWithPrefix,
  nowIso,
  parseJson,
  stringifyJson,
};
