const fs = require('fs');
const path = require('path');

const DEFAULT_LLM_SETTINGS = {
  api_key: '',
  base_url: 'https://api.openai.com/v1',
  model: 'deepseek-v4-flash',
  max_tokens: 4096,
  timeout_ms: 60000,
  max_retries: 3,
};

function getStorageDir(options = {}) {
  return options.storageDir || process.env.DOUYIN_DESKTOP_STORAGE_DIR || path.join(process.cwd(), 'storage');
}

function getSettingsPath(options = {}) {
  return path.join(getStorageDir(options), 'settings.json');
}

function readRootConfig() {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function readSettings(options = {}) {
  const rootConfig = readRootConfig();
  const defaults = {
    llm: {
      ...DEFAULT_LLM_SETTINGS,
      ...(rootConfig.llm || {}),
    },
  };

  try {
    const raw = fs.readFileSync(getSettingsPath(options), 'utf8');
    const saved = JSON.parse(raw) || {};
    return {
      ...defaults,
      ...saved,
      llm: {
        ...defaults.llm,
        ...(saved.llm || {}),
      },
    };
  } catch {
    return defaults;
  }
}

function writeSettings(settings, options = {}) {
  const storageDir = getStorageDir(options);
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(getSettingsPath(options), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

function getLlmSettings(options = {}) {
  return readSettings(options).llm;
}

function updateLlmSettings(patch, options = {}) {
  const current = readSettings(options);
  const next = {
    ...current,
    llm: {
      ...current.llm,
      ...sanitizeLlmPatch(patch),
    },
  };
  return writeSettings(next, options).llm;
}

function sanitizeLlmPatch(patch = {}) {
  const next = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'api_key')) {
    next.api_key = String(patch.api_key || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'base_url')) {
    next.base_url = String(patch.base_url || DEFAULT_LLM_SETTINGS.base_url).trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
    next.model = String(patch.model || DEFAULT_LLM_SETTINGS.model).trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'max_tokens')) {
    const value = Number(patch.max_tokens);
    next.max_tokens = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LLM_SETTINGS.max_tokens;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'timeout_ms')) {
    const value = Number(patch.timeout_ms);
    next.timeout_ms = Number.isFinite(value) && value >= 1000 ? Math.floor(value) : DEFAULT_LLM_SETTINGS.timeout_ms;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'max_retries')) {
    const value = Number(patch.max_retries);
    next.max_retries = Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_LLM_SETTINGS.max_retries;
  }
  return next;
}

function redactLlmSettings(settings) {
  const apiKey = String(settings.api_key || '');
  return {
    ...settings,
    api_key: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '',
    has_api_key: Boolean(apiKey),
  };
}

module.exports = {
  DEFAULT_LLM_SETTINGS,
  getLlmSettings,
  readSettings,
  redactLlmSettings,
  updateLlmSettings,
};
