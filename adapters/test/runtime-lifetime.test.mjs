import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeLifetime } from '../runtime-lifetime.mjs';

const deferred = () => Promise.withResolvers();

test('discovery and turn cleanup pause expiry without renewing computer-use activity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const closed = deferred();
  let closes = 0;
  const lifetime = createRuntimeLifetime(async () => ({ close: async () => { closes++; closed.resolve(); } }), { timeout: 100 });
  await lifetime.run(() => {});
  t.mock.timers.tick(60);
  await lifetime.run(() => {}, { startIfMissing: false, activity: false });
  t.mock.timers.tick(30);
  const cleanup = deferred();
  const entered = deferred();
  const passive = lifetime.run(async () => { entered.resolve(); await cleanup.promise; }, { startIfMissing: false, activity: false });
  await entered.promise;
  t.mock.timers.tick(100);
  assert.equal(closes, 0, 'even passive cleanup must finish before idle close');
  cleanup.resolve();
  await passive;
  t.mock.timers.tick(1);
  await closed.promise;
  assert.equal(closes, 1, 'passive traffic must not keep an unused runtime alive');
  await lifetime.close();
});

test('shutdown waits for startup and its in-flight operation before closing, exactly once', async () => {
  const started = deferred();
  const finishStart = deferred();
  const entered = deferred();
  const finishCall = deferred();
  let closes = 0;
  const lifetime = createRuntimeLifetime(async () => {
    started.resolve();
    await finishStart.promise;
    return { close: async () => { closes++; } };
  });
  const call = lifetime.run(async () => { entered.resolve(); await finishCall.promise; return 'done'; });
  await started.promise;
  const closing = lifetime.close();
  finishStart.resolve();
  await entered.promise;
  assert.equal(closes, 0);
  finishCall.resolve();
  assert.equal(await call, 'done');
  await closing;
  await lifetime.close();
  assert.equal(closes, 1);
});

test('failed idle close cannot start a second runtime; shutdown retries its cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = deferred();
  let starts = 0;
  let closes = 0;
  const lifetime = createRuntimeLifetime(async () => {
    starts++;
    return { close: async () => { if (++closes === 1) throw new Error('cleanup failed'); } };
  }, { timeout: 10, onError: error => failed.resolve(error) });
  await lifetime.run(() => {});
  t.mock.timers.tick(10);
  assert.match((await failed.promise).message, /cleanup failed/);
  await assert.rejects(lifetime.run(() => {}), /could not release/);
  assert.equal(starts, 1);
  await lifetime.close();
  assert.equal(closes, 2);
});
