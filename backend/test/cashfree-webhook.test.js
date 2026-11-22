const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

process.env.CASHFREE_CLIENT_ID = 'sandbox-test-client';
process.env.CASHFREE_CLIENT_SECRET = 'cashfree-webhook-test-secret';
process.env.CASHFREE_CURRENCY = 'INR';

const { verifyCashfreeWebhook } = require('../routes/api');

const timestamp = '1784813400';
const rawBody = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK"}');
const signatureFor = (body) => createHmac('sha256', process.env.CASHFREE_CLIENT_SECRET)
  .update(timestamp + body.toString('utf8'))
  .digest('base64');

test('accepts a Cashfree signature for the exact raw payload', () => {
  assert.equal(verifyCashfreeWebhook(rawBody, timestamp, signatureFor(rawBody)), true);
});

test('rejects a signature when the webhook body has changed', () => {
  const signature = signatureFor(rawBody);
  assert.equal(verifyCashfreeWebhook(Buffer.from(`${rawBody.toString()} `), timestamp, signature), false);
});

test('rejects missing headers, non-raw bodies, and malformed signatures', () => {
  assert.equal(verifyCashfreeWebhook(rawBody, '', signatureFor(rawBody)), false);
  assert.equal(verifyCashfreeWebhook(rawBody.toString(), timestamp, signatureFor(rawBody)), false);
  assert.equal(verifyCashfreeWebhook(rawBody, timestamp, 'not-a-signature'), false);
});
