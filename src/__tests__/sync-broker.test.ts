import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SyncRequestBroker } from '../sync-broker';
import { warn } from '../logger';
vi.mock('../logger', () => ({ warn: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());
const value = { delta: new Uint8Array([1]), serverVV: '{}' };
function setup() {
  const send = vi.fn(); const log = vi.fn();
  const broker = new SyncRequestBroker(send, log);
  const request = (key = 'x', vv: string | null = null) => broker.request(key, vv).catch(e => e);
  return { send, log, broker, request };
}
it('serializes FIFO per key and isolates keys', async () => {
  const { broker: b, send, request } = setup();
  const a = request('x', 'a'), c = request('x', 'b'), d = request('x', 'c'), other = request('y');
  expect(send.mock.calls).toEqual([['x', 'a'], ['y', null]]);
  b.deliver('x', 'sync_delta', value); expect(await a).toBe(value);
  expect(send).toHaveBeenLastCalledWith('x', 'b');
  b.deliver('x', 'doc_unknown', null); expect(await c).toBeNull();
  expect(send).toHaveBeenLastCalledWith('x', 'c');
  b.deliver('x', 'sync_delta', value); b.deliver('y', 'doc_unknown', null);
  expect(await d).toBe(value); expect(await other).toBeNull();
});
it.each(['sync_delta', 'doc_unknown'] as const)('retains wire ownership and logs %s exactly once', async kind => {
  const { broker: b, send, log, request } = setup();
  const a = request(); await vi.advanceTimersByTimeAsync(30_000); const next = request();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(await a).toEqual(new Error('WS request timeout: sync_delta:x'));
  expect(send).toHaveBeenCalledTimes(1);
  expect(b.deliver('x', kind, null)).toBe(true);
  expect(log).toHaveBeenCalledExactlyOnceWith(kind, 'x');
  expect(send).toHaveBeenCalledTimes(2);
  b.deliver('x', 'sync_delta', value); expect(await next).toBe(value);
  expect(b.deliver('x', kind, null)).toBe(false); expect(log).toHaveBeenCalledTimes(1);
});
it('removes queued timeouts without sending them', async () => {
  const { broker: b, send, request } = setup();
  const a = request(); await vi.advanceTimersByTimeAsync(30_000); const middle = request('x', 'b');
  await vi.advanceTimersByTimeAsync(20_000); const last = request('x', 'c');
  await vi.advanceTimersByTimeAsync(50_000);
  expect(await a).toBeInstanceOf(Error); expect(await middle).toBeInstanceOf(Error);
  b.deliver('x', 'sync_delta', value);
  expect(send.mock.calls).toEqual([['x', null], ['x', 'c']]);
  b.deliver('x', 'sync_delta', value); expect(await last).toBe(value);
});
it('does not reset enqueue deadline on promotion', async () => {
  const { broker: b, request } = setup(); const a = request();
  await vi.advanceTimersByTimeAsync(10_000); const next = request();
  await vi.advanceTimersByTimeAsync(49_000); b.deliver('x', 'doc_unknown', null); await a;
  await vi.advanceTimersByTimeAsync(11_000); expect(await next).toBeInstanceOf(Error);
  b.rejectAll('cleanup', 'tag');
});
it.each([false, true])('fails owner (waiterless=%s) silently and promotes', async expired => {
  const { broker: b, log, send, request } = setup(); const a = request();
  await vi.advanceTimersByTimeAsync(30_000); const next = request();
  if (expired) await vi.advanceTimersByTimeAsync(30_000);
  expect(b.fail('x', new Error('failed'))).toBe(true); expect(await a).toBeInstanceOf(Error);
  expect(send).toHaveBeenCalledTimes(2); expect(log).not.toHaveBeenCalled();
  b.deliver('x', 'doc_unknown', null); expect(await next).toBeNull();
  expect(b.fail('x', new Error())).toBe(false);
});
it.each([false, true])('cleans all living waiters and permits key reuse (expired=%s)', async expired => {
  const { broker: b, request, send } = setup(); const a = request();
  await vi.advanceTimersByTimeAsync(30_000); const next = request();
  if (expired) await vi.advanceTimersByTimeAsync(30_000);
  b.rejectAll('closed', 'tag');
  expect(warn).toHaveBeenCalledExactlyOnceWith(`tag rejecting ${expired ? 1 : 2} pending promises: closed`);
  expect(await a).toBeInstanceOf(Error); expect(await next).toEqual(new Error('closed'));
  expect(b.deliver('x', 'doc_unknown', null)).toBe(false);
  const fresh = request(); expect(send).toHaveBeenCalledTimes(2);
  b.deliver('x', 'doc_unknown', null); expect(await fresh).toBeNull();
});
it('rejects an initial sender failure, removes the queue and permits key reuse', async () => {
  const { broker: b, request, send } = setup();
  const error = new Error('first send failed');
  send.mockImplementationOnce(() => { throw error; });
  const first = request();
  expect(await first).toBe(error);
  expect(send).toHaveBeenCalledTimes(1);
  expect(b.deliver('x', 'doc_unknown', null)).toBe(false);
  const next = request();
  expect(send.mock.calls).toEqual([['x', null], ['x', null]]);
  expect(b.deliver('x', 'doc_unknown', null)).toBe(true);
  expect(await next).toBeNull();
});
it('contains sender failures and attempts the next entry', async () => {
  const { broker: b, request, send } = setup(); const a = request(), next = request(), last = request();
  const error = new Error('send failed'); send.mockImplementationOnce(() => { throw error; });
  expect(() => b.deliver('x', 'doc_unknown', null)).not.toThrow();
  expect(await a).toBeNull(); expect(await next).toBe(error); expect(send).toHaveBeenCalledTimes(3);
  b.deliver('x', 'sync_delta', value); expect(await last).toBe(value);
});
it('outer probe abandonment does not cancel queued broker work', async () => {
  const { broker: b, request, send } = setup(); const owner = request(); const probe = request();
  const outer = Promise.race([probe, new Promise(resolve => setTimeout(() => resolve('abandoned'), 5_000))]);
  await vi.advanceTimersByTimeAsync(5_000); expect(await outer).toBe('abandoned');
  b.deliver('x', 'doc_unknown', null); await owner; expect(send).toHaveBeenCalledTimes(2);
  b.deliver('x', 'doc_unknown', null); await probe;
});
