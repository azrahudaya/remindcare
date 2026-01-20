'use strict';

const assert = require('assert');
const { DateTime } = require('luxon');
const {
  parseYesNo,
  normalizeTimeInput,
  parseHpht,
  shouldSendNow
} = require('../index');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`fail - ${name}`);
    throw err;
  }
}

test('parseYesNo returns boolean or null', () => {
  assert.strictEqual(parseYesNo('ya'), true);
  assert.strictEqual(parseYesNo('tidak'), false);
  assert.strictEqual(parseYesNo('belum'), false);
  assert.strictEqual(parseYesNo('mungkin'), null);
});

test('normalizeTimeInput handles common inputs', () => {
  assert.strictEqual(normalizeTimeInput('7'), '07:00');
  assert.strictEqual(normalizeTimeInput('730'), '07:30');
  assert.strictEqual(normalizeTimeInput('17.05'), '17:05');
  assert.strictEqual(normalizeTimeInput('17:5'), '17:05');
  assert.strictEqual(normalizeTimeInput('2460'), null);
});

test('parseHpht accepts ymd and dmy', () => {
  assert.strictEqual(parseHpht('2024-01-31').iso, '2024-01-31');
  assert.strictEqual(parseHpht('31-01-2024').iso, '2024-01-31');
  assert.strictEqual(parseHpht('2024-99-99').iso, null);
});

test('shouldSendNow returns true after scheduled time', () => {
  const now = DateTime.fromISO('2024-01-01T10:05:00', { zone: 'Asia/Jakarta' });
  assert.strictEqual(shouldSendNow('10:00', now), true);
  assert.strictEqual(shouldSendNow('10:30', now), false);
  const exact = DateTime.fromISO('2024-01-01T10:00:00', { zone: 'Asia/Jakarta' });
  assert.strictEqual(shouldSendNow('10:00', exact), true);
});
