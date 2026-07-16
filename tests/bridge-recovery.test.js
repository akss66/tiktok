const {
  createRecoveryScheduler,
  executeWithTimeout,
  nextBridgeRetryDelay,
} = require('../desktop/electron/bridge-recovery');

describe('bridge recovery helpers', () => {
  it('uses capped exponential delays for reconnect attempts', () => {
    expect(nextBridgeRetryDelay(0)).toBe(1000);
    expect(nextBridgeRetryDelay(1)).toBe(2000);
    expect(nextBridgeRetryDelay(4)).toBe(16000);
    expect(nextBridgeRetryDelay(10)).toBe(30000);
  });

  it('debounces repeated page lifecycle recovery requests', async () => {
    const callbacks = [];
    let runs = 0;
    const scheduler = createRecoveryScheduler(async () => {
      runs += 1;
    }, {
      setTimer: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimer: () => {},
    });

    scheduler.schedule(500);
    scheduler.schedule(500);
    scheduler.schedule(500);
    expect(callbacks).toHaveLength(3);

    await callbacks[0]();
    await callbacks[1]();
    await callbacks[2]();
    expect(runs).toBe(1);

    scheduler.schedule(500);
    await callbacks[3]();
    expect(runs).toBe(2);
  });

  it('rejects a page execution that never settles so browser reload cannot stall the monitor forever', async () => {
    let timeoutCallback;
    const execution = executeWithTimeout(
      () => new Promise(() => {}),
      20_000,
      {
        setTimer(callback) {
          timeoutCallback = callback;
          return 1;
        },
        clearTimer() {},
        timeoutMessage: 'page execution timed out',
      },
    );

    timeoutCallback();

    await expect(execution).rejects.toMatchObject({
      code: 'PAGE_EXECUTION_TIMEOUT',
      message: 'page execution timed out',
    });
  });
});
