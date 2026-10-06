import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decrypt, encrypt, type Envelope } from './nexo-crypto.ts';

// Shared key of Adyen's own Java library tests (TerminalLocalAPITest.java), which encrypted the fixture.
const ADYEN_TEST_KEY = { keyIdentifier: 'CryptoKeyIdentifier12345', passphrase: 'p@ssw0rd123456', keyVersion: 1 };

test('decrypts a real Adyen terminal response (P400Plus, from the Java library) and checks its HMAC', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/adyen-payment-local-success.json', import.meta.url), 'utf8'));
  const plain = decrypt(fixture.SaleToPOIResponse as Envelope, ADYEN_TEST_KEY);
  assert.ok(plain, 'HMAC matches');
  const message = JSON.parse(plain).SaleToPOIResponse;
  assert.equal(message.PaymentResponse.Response.Result, 'Success');
  assert.deepEqual(message.MessageHeader, fixture.SaleToPOIResponse.MessageHeader, 'the clear header equals the encrypted one');
});

test('round trip, and any tampering or wrong key is rejected', () => {
  const message = { MessageHeader: { ServiceID: '1' }, DiagnosisRequest: { HostDiagnosisFlag: false } };
  const { SaleToPOIRequest: envelope } = encrypt('SaleToPOIRequest', message, ADYEN_TEST_KEY);
  assert.deepEqual(JSON.parse(decrypt(envelope, ADYEN_TEST_KEY)!), { SaleToPOIRequest: message });
  assert.equal(decrypt(envelope, { ...ADYEN_TEST_KEY, passphrase: 'other-p@ssw0rd1' }), null);
  assert.equal(decrypt(envelope, { ...ADYEN_TEST_KEY, keyVersion: 2 }), null);
  const blob = Buffer.from(envelope.NexoBlob, 'base64');
  blob[blob.length - 20] ^= 1;
  assert.equal(decrypt({ ...envelope, NexoBlob: blob.toString('base64') }, ADYEN_TEST_KEY), null);
});
