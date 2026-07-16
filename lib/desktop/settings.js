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

const DEFAULT_REPLY_SETTINGS = {
  intent_threshold: 'medium',
  require_knowledge: true,
  max_draft_chars: 60,
};

const DEFAULT_DM_SETTINGS = {
  reply_mode: 'manual',
  auto_reply_frequency: 'once',
  knowledge_confidence: 0.85,
  auto_delay_min_ms: 15000,
  auto_delay_max_ms: 45000,
  monitor_after_login: false,
  notifications_enabled: true,
  notification_preview: true,
  quiet_hours_start: '',
  quiet_hours_end: '',
};

const DM_REPLY_MODES = new Set(['manual', 'tiered', 'automatic']);
const DM_AUTO_REPLY_FREQUENCIES = new Set(['once', 'always']);

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
    reply: {
      ...DEFAULT_REPLY_SETTINGS,
      ...(rootConfig.reply || {}),
    },
    dm: sanitizeDmSettings({
      ...DEFAULT_DM_SETTINGS,
      ...(rootConfig.dm || {}),
    }),
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
      reply: {
        ...defaults.reply,
        ...(saved.reply || {}),
      },
      dm: sanitizeDmSettings({
        ...defaults.dm,
        ...(saved.dm || {}),
      }),
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

function getReplySettings(options = {}) {
  return readSettings(options).reply;
}

function updateReplySettings(patch, options = {}) {
  const current = readSettings(options);
  const next = {
    ...current,
    reply: {
      ...current.reply,
      ...sanitizeReplyPatch(patch),
    },
  };
  return writeSettings(next, options).reply;
}

function getDmSettings(options = {}) {
  return readSettings(options).dm;
}

function updateDmSettings(patch, options = {}) {
  const current = readSettings(options);
  const dm = {
    ...current.dm,
    ...sanitizeDmPatch(patch),
  };
  applyQuietHoursPair(dm, current.dm, patch);
  const next = {
    ...current,
    dm: sanitizeDmSettings(dm),
  };
  return writeSettings(next, options).dm;
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

function sanitizeReplyPatch(patch = {}) {
  const next = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'intent_threshold')) {
    next.intent_threshold = patch.intent_threshold === 'high' ? 'high' : 'medium';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'require_knowledge')) {
    next.require_knowledge = Boolean(patch.require_knowledge);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'max_draft_chars')) {
    const value = Number(patch.max_draft_chars);
    next.max_draft_chars = Number.isFinite(value)
      ? Math.min(200, Math.max(20, Math.floor(value)))
      : DEFAULT_REPLY_SETTINGS.max_draft_chars;
  }
  return next;
}

function clampNumber(value, min, max, integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = integer ? Math.floor(parsed) : parsed;
  return Math.min(max, Math.max(min, normalized));
}

function normalizeQuietHour(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return '';
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function sanitizeDmPatch(patch = {}) {
  const next = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'reply_mode')) {
    const mode = String(patch.reply_mode || '').trim();
    if (DM_REPLY_MODES.has(mode)) {
      next.reply_mode = mode;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'auto_reply_frequency')) {
    const frequency = String(patch.auto_reply_frequency || '').trim();
    if (DM_AUTO_REPLY_FREQUENCIES.has(frequency)) {
      next.auto_reply_frequency = frequency;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'knowledge_confidence')) {
    const value = clampNumber(patch.knowledge_confidence, 0.5, 1);
    if (value !== null) {
      next.knowledge_confidence = value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'auto_delay_min_ms')) {
    const value = clampNumber(patch.auto_delay_min_ms, 0, 100000, true);
    if (value !== null) {
      next.auto_delay_min_ms = value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'auto_delay_max_ms')) {
    const value = clampNumber(patch.auto_delay_max_ms, 0, 100000, true);
    if (value !== null) {
      next.auto_delay_max_ms = value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'monitor_after_login') && typeof patch.monitor_after_login === 'boolean') {
    next.monitor_after_login = patch.monitor_after_login;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notifications_enabled') && typeof patch.notifications_enabled === 'boolean') {
    next.notifications_enabled = patch.notifications_enabled;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notification_preview') && typeof patch.notification_preview === 'boolean') {
    next.notification_preview = patch.notification_preview;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'quiet_hours_start')) {
    const value = normalizeQuietHour(patch.quiet_hours_start);
    if (value !== null) {
      next.quiet_hours_start = value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'quiet_hours_end')) {
    const value = normalizeQuietHour(patch.quiet_hours_end);
    if (value !== null) {
      next.quiet_hours_end = value;
    }
  }
  return next;
}

function sanitizeDmSettings(input = {}) {
  const next = {
    ...DEFAULT_DM_SETTINGS,
    ...sanitizeDmPatch(input),
  };
  applyQuietHoursPair(next, DEFAULT_DM_SETTINGS, input);
  if (next.auto_delay_max_ms < next.auto_delay_min_ms) {
    next.auto_delay_max_ms = next.auto_delay_min_ms;
  }
  return next;
}

function applyQuietHoursPair(target, current, patch = {}) {
  const hasStart = Object.prototype.hasOwnProperty.call(patch, 'quiet_hours_start');
  const hasEnd = Object.prototype.hasOwnProperty.call(patch, 'quiet_hours_end');
  const currentStart = String(current?.quiet_hours_start || '');
  const currentEnd = String(current?.quiet_hours_end || '');

  if (!hasStart && !hasEnd) {
    if (!currentStart || !currentEnd) {
      target.quiet_hours_start = '';
      target.quiet_hours_end = '';
    }
    return target;
  }

  const startValue = hasStart ? normalizeQuietHour(patch.quiet_hours_start) : currentStart;
  const endValue = hasEnd ? normalizeQuietHour(patch.quiet_hours_end) : currentEnd;

  if ((hasStart && startValue === '') || (hasEnd && endValue === '')) {
    target.quiet_hours_start = '';
    target.quiet_hours_end = '';
    return target;
  }

  const candidateStart = startValue === null ? currentStart : startValue;
  const candidateEnd = endValue === null ? currentEnd : endValue;

  if (candidateStart && candidateEnd) {
    target.quiet_hours_start = candidateStart;
    target.quiet_hours_end = candidateEnd;
    return target;
  }

  if (currentStart && currentEnd) {
    target.quiet_hours_start = currentStart;
    target.quiet_hours_end = currentEnd;
    return target;
  }

  target.quiet_hours_start = '';
  target.quiet_hours_end = '';
  return target;
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
  DEFAULT_DM_SETTINGS,
  DEFAULT_LLM_SETTINGS,
  DEFAULT_REPLY_SETTINGS,
  getDmSettings,
  getLlmSettings,
  getReplySettings,
  readSettings,
  redactLlmSettings,
  sanitizeDmPatch,
  sanitizeLlmPatch,
  updateDmSettings,
  updateLlmSettings,
  updateReplySettings,
};
