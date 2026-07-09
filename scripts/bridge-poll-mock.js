const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const BRIDGE_HOST = process.env.BRIDGE_HOST || 'http://127.0.0.1:19422';
const BRIDGE_SITE = process.env.BRIDGE_SITE || 'douyin.com';

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const bridge = cfg.bridge || {};
    return {
      token: bridge.token || '',
      host: bridge.host || '127.0.0.1',
      port: bridge.port || 19422,
      site: BRIDGE_SITE,
    };
  } catch (error) {
    return {
      token: '',
      host: '127.0.0.1',
      port: 19422,
      site: BRIDGE_SITE,
    };
  }
}

const config = loadConfig();
const bridgeBase = config.host && config.port ? `http://${config.host}:${config.port}` : BRIDGE_HOST;
const authHeader = config.token ? { Authorization: `Bearer ${config.token}` } : {};

function parseArgs(argv) {
  const options = {
    maxRuns: Number.POSITIVE_INFINITY,
    pollDelayMs: 500,
    site: config.site,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--max-runs' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n > 0) options.maxRuns = n;
      i += 1;
      continue;
    }
    if (token === '--poll-delay-ms' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isNaN(n) && n >= 0) options.pollDelayMs = n;
      i += 1;
      continue;
    }
    if (token === '--site' && argv[i + 1]) {
      options.site = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--verbose') options.verbose = true;
  }

  return options;
}

async function request(method, urlPath, body) {
  const headers = {
    'content-type': 'application/json',
    ...authHeader,
  };

  const bodyText = body ? JSON.stringify(body) : undefined;

  const response = await fetch(`${bridgeBase}${urlPath}`, {
    method,
    headers,
    body: bodyText,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = null;
    }
  }

  if (!response.ok) {
    const reason = payload?.error || text || `HTTP ${response.status}`;
    throw new Error(`[poll-mock] bridge ${method} ${urlPath} failed: ${reason}`);
  }

  return payload || {};
}

function unquote(value) {
  if (!value) return '';
  return value
    .replace(/\\'/g, '\'')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractQuotedArgs(expression) {
  const result = [];
  const pattern = /'((?:\\.|[^'\\])*)'/g;
  let match = null;
  while ((match = pattern.exec(expression)) !== null) {
    result.push(unquote(match[1]));
  }
  return result;
}

function mockEval(expression = '') {
  const args = extractQuotedArgs(expression);

  if (expression.includes('window.__bridge.search(')) {
    const keyword = args[0] || 'mock-keyword';
    return {
      data: [
        { aweme_info: { aweme_id: 'mock-aweme-1', desc: `search mock for ${keyword}`, author: { nickname: 'demo-author' } } },
        { aweme_info: { aweme_id: 'mock-aweme-2', desc: `search mock 2 for ${keyword}`, author: { nickname: 'demo-author-2' } } },
      ],
      total: 2,
      cursor: 0,
    };
  }

  if (expression.includes('window.__bridge.digg(')) {
    return {
      status_code: 0,
      status_msg: 'ok',
      aweme_id: args[0] || '',
    };
  }

  if (expression.includes('window.__bridge.publish(')) {
    const awemeId = args[0] || '';
    const text = args[1] || '';
    return {
      status_code: 0,
      comment: {
        cid: `mock-comment-${Date.now()}`,
        text,
        aweme_id: awemeId,
      },
    };
  }

  if (expression.includes('window.__bridge.deleteComment(')) {
    return {
      status_code: 0,
      status_msg: 'deleted',
      cid: args[0] || '',
    };
  }

  throw new Error(`mock client does not understand expression: ${expression}`);
}

async function connect(site) {
  return request('POST', '/api/connect', {
    site,
    url: `${bridgeBase}/`,
    title: 'Desktop Poll Mock',
    userAgent: 'poll-mock-client',
  });
}

async function pollLoop(options) {
  const state = { runs: 0 };
  const connection = await connect(options.site);
  const clientId = connection.id || '';
  console.log('[poll-mock] connect:', connection);

  while (state.runs < options.maxRuns) {
    const query = new URLSearchParams({ site: options.site });
    if (clientId) query.set('connId', clientId);
    const poll = await request('GET', `/api/poll?${query.toString()}`);

    if (poll.type === 'eval' && poll.id && poll.expression) {
      state.runs += 1;
      try {
        const value = mockEval(poll.expression);
        if (options.verbose) {
          console.log('[poll-mock] eval', {
            id: poll.id,
            expression: poll.expression,
            value,
          });
        } else {
          console.log(`[poll-mock] eval #${state.runs} ->`, poll.expression.slice(0, 80));
        }
        await request('POST', '/api/result', { id: poll.id, value });
      } catch (error) {
        await request('POST', '/api/result', { id: poll.id, error: error.message });
      }
    } else if (options.verbose) {
      console.log('[poll-mock] idle', poll);
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollDelayMs));
  }

  console.log('[poll-mock] reached maxRuns, exit.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.on('SIGINT', () => {
    console.log('\n[poll-mock] stopped');
    process.exit(0);
  });

  try {
    await pollLoop(options);
    process.exit(0);
  } catch (error) {
    console.error('[poll-mock] fatal:', error.message);
    process.exit(1);
  }
}

main();
