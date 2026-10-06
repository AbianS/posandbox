import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedRequest, RateLimiter } from './guard.ts';

const allowed = ['localhost', '127.0.0.1', '[::1]'];

test('accepts loopback hosts with any port and no origin (curl, the POS tooling)', () => {
  assert.equal(isAllowedRequest({ host: 'localhost:8100' }, allowed), true);
  assert.equal(isAllowedRequest({ host: '127.0.0.1:8100' }, allowed), true);
  assert.equal(isAllowedRequest({ host: '[::1]:8100' }, allowed), true);
});

test('rejects foreign hosts (DNS rebinding) and missing host', () => {
  assert.equal(isAllowedRequest({ host: 'evil.example:8100' }, allowed), false);
  assert.equal(isAllowedRequest({}, allowed), false);
});

test('accepts same-origin browsers and rejects other origins', () => {
  assert.equal(isAllowedRequest({ host: 'localhost:8100', origin: 'http://localhost:8100' }, allowed), true);
  assert.equal(isAllowedRequest({ host: 'localhost:8100', origin: 'http://localhost:5173' }, allowed), false);
  assert.equal(isAllowedRequest({ host: 'localhost:8100', origin: 'https://evil.example' }, allowed), false);
  assert.equal(isAllowedRequest({ host: 'localhost:8100', origin: 'null' }, allowed), false);
});

test('allows extra hosts configured explicitly (e.g. a docker service name)', () => {
  assert.equal(isAllowedRequest({ host: 'posandbox:8100' }, [...allowed, 'posandbox']), true);
});

test('rate limiter allows a burst per client and then refuses until the window passes', () => {
  let now = 0;
  const limiter = new RateLimiter(3, 1000, () => now);
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.take('a')), [true, true, true, false]);
  assert.equal(limiter.take('b'), true);
  now = 1000;
  assert.equal(limiter.take('a'), true);
});
