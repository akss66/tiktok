const MAX_BRIDGE_RETRY_DELAY_MS = 30000;

function executeWithTimeout(execute, timeoutMs, options = {}) {
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const durationMs = Math.max(1, Number(timeoutMs) || 1);
  const timeoutMessage = options.timeoutMessage || `Page execution timed out after ${durationMs}ms`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      callback(value);
    };
    const timer = setTimer(() => {
      const error = new Error(timeoutMessage);
      error.code = 'PAGE_EXECUTION_TIMEOUT';
      finish(reject, error);
    }, durationMs);

    Promise.resolve()
      .then(() => execute())
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

function nextBridgeRetryDelay(attempt) {
  return Math.min(MAX_BRIDGE_RETRY_DELAY_MS, 1000 * (2 ** Math.max(0, Number(attempt) || 0)));
}

function createRecoveryScheduler(run, options = {}) {
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let timer = null;
  let generation = 0;

  return {
    schedule(delayMs = 500) {
      generation += 1;
      const currentGeneration = generation;
      if (timer) clearTimer(timer);
      timer = setTimer(async () => {
        if (currentGeneration !== generation) return;
        timer = null;
        await run();
      }, delayMs);
    },
    cancel() {
      generation += 1;
      if (timer) clearTimer(timer);
      timer = null;
    },
    pending() {
      return Boolean(timer);
    },
  };
}

module.exports = {
  MAX_BRIDGE_RETRY_DELAY_MS,
  createRecoveryScheduler,
  executeWithTimeout,
  nextBridgeRetryDelay,
};
