'use strict';

const assert = require('assert');
const { DateTime } = require('luxon');
const {
  parseYesNo,
  normalizeTimeInput,
  parseHpht,
  shouldSendNow,
  getHplDate,
  getDeliveryValidationStageDue,
  buildLaborPhaseMessage,
  parseDeliveryValidationAnswer
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

test('getHplDate calculates 40 weeks from hpht', () => {
  const hpl = getHplDate({ hpht_iso: '2024-01-01' });
  assert.ok(hpl);
  const expected = DateTime.fromISO('2024-01-01', { zone: 'Asia/Jakarta' })
    .plus({ days: 280 })
    .toFormat('yyyy-LL-dd');
  assert.strictEqual(hpl.toFormat('yyyy-LL-dd'), expected);
});

test('delivery validation stage is hpl and hpl+3', () => {
  const hplNow = DateTime.fromISO('2024-10-07T09:00:00', { zone: 'Asia/Jakarta' });
  const hpl3Now = hplNow.plus({ days: 3 });
  const baseUser = { hpht_iso: '2024-01-01' };

  assert.strictEqual(getDeliveryValidationStageDue(baseUser, hplNow), 'hpl');
  assert.strictEqual(
    getDeliveryValidationStageDue(
      { ...baseUser, delivery_hpl_response: 'Belum' },
      hpl3Now,
    ),
    'hpl3',
  );
});

test('buildLaborPhaseMessage stops after hpl is answered', () => {
  const week37Now = DateTime.fromISO('2024-09-09T08:00:00', { zone: 'Asia/Jakarta' });
  const user = { hpht_iso: '2024-01-01' };
  assert.ok(buildLaborPhaseMessage(user, week37Now));
  assert.strictEqual(
    buildLaborPhaseMessage({ ...user, delivery_hpl_response: 'Belum' }, week37Now),
    null,
  );
});

test('parseDeliveryValidationAnswer only handles melahirkan intent', () => {
  assert.strictEqual(parseDeliveryValidationAnswer('Sudah melahirkan'), 'Sudah');
  assert.strictEqual(parseDeliveryValidationAnswer('Belum melahirkan'), 'Belum');
  assert.strictEqual(parseDeliveryValidationAnswer('sudah'), null);
});
