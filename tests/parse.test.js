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
  parseDeliveryValidationAnswer,
  getDeliveryDateTime,
  getPostpartumDueAt,
  buildPostpartumSnapshot,
  getRetryDelayMs,
  canAttemptByBackoff,
  validateDeliveryDateIso,
  validateDeliveryDateTime
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

test('getDeliveryDateTime returns valid datetime from delivery date+time', () => {
  const deliveryAt = getDeliveryDateTime({
    delivery_date_iso: '2026-01-10',
    delivery_time: '14:30'
  });
  assert.ok(deliveryAt);
  assert.strictEqual(deliveryAt.toFormat('yyyy-LL-dd HH:mm'), '2026-01-10 14:30');
});

test('getPostpartumDueAt calculates due time based on visit start hour', () => {
  const deliveryAt = DateTime.fromISO('2026-01-10T14:30:00', { zone: 'Asia/Jakarta' });
  const dueAt = getPostpartumDueAt(deliveryAt, { startHours: 6 });
  assert.ok(dueAt);
  assert.strictEqual(dueAt.toFormat('yyyy-LL-dd HH:mm'), '2026-01-10 20:30');
});

test('buildPostpartumSnapshot summarizes visit status', () => {
  const snapshot = buildPostpartumSnapshot([
    { visit_code: 'KF1', sent_at: '2026-01-10T20:30:00', response: 'Sudah', response_at: '2026-01-10T21:00:00' },
    { visit_code: 'KN1', sent_at: '2026-01-10T20:31:00', response: 'Belum', response_at: '2026-01-10T21:05:00' },
    { visit_code: 'KF2', sent_at: '2026-01-13T14:30:00', response: null, response_at: null }
  ]);
  assert.strictEqual(snapshot.postpartum_total, 3);
  assert.strictEqual(snapshot.postpartum_sent, 3);
  assert.strictEqual(snapshot.postpartum_sudah, 1);
  assert.strictEqual(snapshot.postpartum_belum, 1);
  assert.strictEqual(snapshot.postpartum_pending, 1);
  assert.strictEqual(snapshot.kf1_response, 'Sudah');
  assert.strictEqual(snapshot.kn1_response, 'Belum');
});

test('retry backoff delay increases and caps', () => {
  assert.strictEqual(getRetryDelayMs(0), 0);
  assert.ok(getRetryDelayMs(1) > 0);
  assert.ok(getRetryDelayMs(4) >= getRetryDelayMs(3));
  assert.ok(getRetryDelayMs(20) <= 30 * 60 * 1000);
});

test('canAttemptByBackoff blocks during delay and allows after delay', () => {
  const now = DateTime.fromISO('2026-02-19T10:00:00', { zone: 'Asia/Jakarta' });
  const oneMinuteAgo = now.minus({ minutes: 1 }).toISO();
  const tenMinutesAgo = now.minus({ minutes: 10 }).toISO();
  assert.strictEqual(canAttemptByBackoff(oneMinuteAgo, 1, now), false);
  assert.strictEqual(canAttemptByBackoff(tenMinutesAgo, 1, now), true);
  assert.strictEqual(canAttemptByBackoff(null, 2, now), true);
});

test('validateDeliveryDateIso rejects future date and before hpht', () => {
  const now = DateTime.fromISO('2026-02-19T10:00:00', { zone: 'Asia/Jakarta' });
  const user = { hpht_iso: '2025-06-01' };
  assert.strictEqual(validateDeliveryDateIso('2026-02-20', user, now).valid, false);
  assert.strictEqual(validateDeliveryDateIso('2025-05-30', user, now).valid, false);
  assert.strictEqual(validateDeliveryDateIso('2026-02-19', user, now).valid, true);
});

test('validateDeliveryDateTime rejects future time', () => {
  const now = DateTime.fromISO('2026-02-19T10:00:00', { zone: 'Asia/Jakarta' });
  const user = { hpht_iso: '2025-06-01' };
  const future = validateDeliveryDateTime(user, '2026-02-19', '23:00', now);
  const valid = validateDeliveryDateTime(user, '2026-02-19', '09:30', now);
  assert.strictEqual(future.valid, false);
  assert.strictEqual(valid.valid, true);
});
