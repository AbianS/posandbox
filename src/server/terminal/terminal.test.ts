import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLab, type RunningLab } from '../main.ts';
import { decrypt, encrypt, type Envelope } from './nexo-crypto.ts';
import type { Timing } from './terminal.ts';

const FAST: Timing = { read: { Contactless: 5, ICC: 5, MagStripe: 5 }, authorize: 10, result: 20, pinError: 5, cardTimeout: 400, pinTimeout: 400, autoShopper: 20, issuerTimeout: 60 };
const KEY = { keyIdentifier: 'CryptoKeyIdentifier12345', passphrase: 'p@ssw0rd123456', keyVersion: 1 };

async function withTerminal(fn: (pos: Pos, lab: RunningLab) => Promise<void>, dataDir = mkdtempSync(join(tmpdir(), 'psbx-term-'))) {
  const lab = await startLab({ dataDir, staticDir: '.', host: '127.0.0.1', httpPort: 0, printerPort: 0, terminalPort: 0, timing: FAST });
  try {
    await fn(new Pos(lab), lab);
  } finally {
    await lab.stop();
  }
}

/** A POS like Adyen's Node library: POST /nexo/ over TLS, trusting the given CA, checking only the CN pattern. */
class Pos {
  #lab: RunningLab;
  #service = 0;
  key: typeof KEY | null = null;
  constructor(lab: RunningLab) {
    this.#lab = lab;
  }

  get terminal() {
    return this.#lab.lab.terminal('counter')!;
  }

  message(category: string, body: object, serviceId = String(++this.#service)) {
    return {
      MessageHeader: { ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: category, MessageType: 'Request', SaleID: 'POS1', ServiceID: serviceId, POIID: 'V400m-324688179' },
      [`${category}Request`]: body,
    };
  }

  payment(amount: number, serviceId?: string, currency = 'EUR', paymentType?: 'Refund') {
    return this.message('Payment', {
      SaleData: { SaleTransactionID: { TransactionID: `ref-${amount}`, TimeStamp: new Date().toISOString() } },
      PaymentTransaction: { AmountsReq: { Currency: currency, RequestedAmount: amount } },
      ...(paymentType ? { PaymentData: { PaymentType: paymentType } } : {}),
    }, serviceId);
  }

  reversal(transactionId: string, amount?: number, serviceId?: string) {
    return this.message('Reversal', {
      OriginalPOITransaction: { POITransactionID: { TransactionID: transactionId, TimeStamp: new Date().toISOString() } },
      ReversalReason: 'MerchantCancel',
      ...(amount !== undefined ? { ReversedAmount: amount, SaleData: { SaleToAcquirerData: 'currency=EUR', SaleTransactionID: { TransactionID: 'refund-1', TimeStamp: new Date().toISOString() } } } : {}),
    }, serviceId);
  }

  async send(message: object): Promise<{ status: number; text: string; json: any; encrypted: boolean }> {
    const body = JSON.stringify(this.key ? encrypt('SaleToPOIRequest', message as { MessageHeader: unknown }, this.key) : { SaleToPOIRequest: message });
    const res = await this.raw(body);
    let json = res.text ? JSON.parse(res.text) : null;
    const encrypted = Boolean(json?.SaleToPOIResponse?.NexoBlob);
    if (encrypted && this.key) {
      const clearHeader = json.SaleToPOIResponse.MessageHeader;
      json = JSON.parse(decrypt(json.SaleToPOIResponse as Envelope, this.key)!);
      assert.deepEqual(json.SaleToPOIResponse.MessageHeader, clearHeader, 'clear header equals the encrypted one');
    }
    return { ...res, json: json?.SaleToPOIResponse ?? json, encrypted };
  }

  raw(body: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: this.#lab.terminalPort('counter')!, path: '/nexo/', method: 'POST',
        headers: { 'content-type': 'application/json' }, ca: this.#lab.lab.terminalCa('counter')!,
        checkServerIdentity: (_h, cert) => (/^[a-zA-Z0-9]+-[a-zA-Z0-9]+\.test\.terminal\.adyen\.com$/.test(String(cert.subject.CN)) ? undefined : new Error('CN')),
      }, (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (c) => (text += c)).on('end', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), 'condition not reached');
};
const additional = (s: string) => Object.fromEntries(new URLSearchParams(s));

test('contactless under the CVM limit: approved without PIN, with the fields a real terminal returns', () =>
  withTerminal(async (pos) => {
    const pending = pos.send(pos.payment(10.99, '744'));
    await until(() => pos.terminal.status().screen.phase === 'card');
    assert.equal(pos.terminal.status().screen.amount?.value, 10.99);
    assert.equal(pos.terminal.present('visa', 'Contactless'), null);
    const { status, json } = await pending;
    assert.equal(status, 200);
    assert.deepEqual(json.MessageHeader, { ...pos.payment(1, '744').MessageHeader, MessageType: 'Response' }, 'header echoed');
    const r = json.PaymentResponse;
    assert.equal(r.Response.Result, 'Success');
    assert.match(r.POIData.POITransactionID.TransactionID, /^[0-9a-z]{4}00\d{10}\d{3}\.[A-Z0-9]{16}$/);
    assert.deepEqual(r.PaymentResult.AmountsResp, { AuthorizedAmount: 10.99, Currency: 'EUR' });
    assert.equal(r.PaymentResult.PaymentInstrumentData.CardData.MaskedPan, '411111 **** 0002');
    assert.deepEqual(r.PaymentResult.PaymentInstrumentData.CardData.EntryMode, ['Contactless']);
    assert.equal(r.PaymentResult.AuthenticationMethod, undefined);
    const extra = additional(r.Response.AdditionalResponse);
    assert.equal(extra.posAuthAmountValue, '1099');
    assert.equal(extra.posEntryMode, 'CLESS_CHIP');
    assert.equal(extra.pspReference, r.POIData.POITransactionID.TransactionID.split('.')[1]);
    assert.equal(extra.merchantReference, 'ref-10.99');
    assert.deepEqual(r.PaymentReceipt.map((p: any) => p.DocumentQualifier), ['CashierReceipt', 'CustomerReceipt']);
    assert.ok(r.PaymentReceipt[1].OutputContent.OutputText.some((l: any) => l.Text === 'name=Card&value=%2a%2a%2a%2a%2a%2a%2a%2a%2a%2a%2a%2a0002&key=pan'));
  }));

test('chip with a wrong then right PIN: approved with OfflinePIN; the card stays inserted until removed', () =>
  withTerminal(async (pos) => {
    const pending = pos.send(pos.payment(60));
    await until(() => pos.terminal.status().screen.phase === 'card');
    pos.terminal.present('maestro', 'ICC');
    await until(() => pos.terminal.status().screen.message === 'Enter PIN');
    for (const k of ['9', '9', '9', '9', 'enter']) pos.terminal.key(k);
    await until(() => pos.terminal.status().screen.message === 'Enter PIN');
    for (const k of ['1', '2', '3', '4', 'enter']) pos.terminal.key(k);
    const r = (await pending).json.PaymentResponse;
    assert.equal(r.Response.Result, 'Success');
    assert.deepEqual(r.PaymentResult.AuthenticationMethod, ['OfflinePIN']);
    assert.equal(pos.terminal.status().cardInserted, 'maestro');
    pos.terminal.removeCard();
    assert.equal(pos.terminal.status().cardInserted, null);
  }));

test("Adyen's test amounts decide the issuer's answer (…124 → not enough balance)", () =>
  withTerminal(async (pos) => {
    pos.terminal.setBehaviour({ shopper: 'auto' });
    const r = (await pos.send(pos.payment(1.24))).json.PaymentResponse;
    assert.equal(r.Response.Result, 'Failure');
    assert.equal(r.Response.ErrorCondition, 'Refusal');
    assert.equal(additional(r.Response.AdditionalResponse).refusalReason, '210 Not enough balance');
    assert.doesNotMatch(r.POIData.POITransactionID.TransactionID, /\./, 'only the tender reference when not approved');
  }));

test('while a payment is in progress: another payment is Busy, status is InProgress, abort cancels it', () =>
  withTerminal(async (pos) => {
    const pending = pos.send(pos.payment(5, 'A1'));
    await until(() => pos.terminal.status().screen.phase === 'card');
    const busy = (await pos.send(pos.payment(6))).json.PaymentResponse.Response;
    assert.equal(busy.ErrorCondition, 'Busy');
    assert.equal(additional(busy.AdditionalResponse).serviceId, 'A1');
    const status = (await pos.send(pos.message('TransactionStatus', { MessageReference: { MessageCategory: 'Payment', SaleID: 'POS1', ServiceID: 'A1' } }))).json.TransactionStatusResponse;
    assert.equal(status.Response.ErrorCondition, 'InProgress');
    const abort = await pos.send(pos.message('Abort', { AbortReason: 'MerchantAbort', MessageReference: { MessageCategory: 'Payment', SaleID: 'POS1', ServiceID: 'A1' } }));
    assert.equal(abort.status, 200);
    assert.equal(abort.text, '', 'abort has no body');
    const r = (await pending).json.PaymentResponse;
    assert.equal(r.Response.ErrorCondition, 'Aborted');
    assert.equal(pos.terminal.status().screen.phase, 'idle', 'no card yet: the payment screen just disappears');
  }));

test('the shopper cancelling on the terminal ends with Cancel', () =>
  withTerminal(async (pos) => {
    const pending = pos.send(pos.payment(5));
    await until(() => pos.terminal.status().screen.phase === 'card');
    pos.terminal.key('cancel');
    assert.equal((await pending).json.PaymentResponse.Response.ErrorCondition, 'Cancel');
  }));

test('lost response: the POS gets no answer, but TransactionStatus returns the original response', () =>
  withTerminal(async (pos) => {
    pos.terminal.setBehaviour({ shopper: 'auto', responseLost: true });
    await assert.rejects(pos.send(pos.payment(7, 'L1')), /socket hang up|ECONNRESET/);
    pos.terminal.setBehaviour({ responseLost: false });
    const status = (await pos.send(pos.message('TransactionStatus', { MessageReference: { MessageCategory: 'Payment', SaleID: 'POS1', ServiceID: 'L1' } }))).json.TransactionStatusResponse;
    assert.equal(status.Response.Result, 'Success');
    const original = status.RepeatedMessageResponse.RepeatedResponseMessageBody.PaymentResponse;
    assert.equal(original.Response.Result, 'Success');
    assert.equal(status.RepeatedMessageResponse.MessageHeader.ServiceID, 'L1');
    const unknown = (await pos.send(pos.message('TransactionStatus', { MessageReference: { MessageCategory: 'Payment', SaleID: 'POS1', ServiceID: 'nope' } }))).json.TransactionStatusResponse;
    assert.equal(unknown.Response.ErrorCondition, 'NotFound');
    assert.match(decodeURIComponent(unknown.Response.AdditionalResponse), /last such Request has SaleID=POS1 ServiceID=L1/);
  }));

test('shared key: encrypted requests get encrypted responses; a wrong key gets 401 crypto error', () =>
  withTerminal(async (pos, lab) => {
    await lab.lab.updateTerminalConfig('counter', { sharedKey: KEY });
    pos.key = KEY;
    const diagnosis = await pos.send(pos.message('Diagnosis', { HostDiagnosisFlag: false }));
    assert.equal(diagnosis.encrypted, true);
    assert.equal(diagnosis.json.DiagnosisResponse.Response.Result, 'Success');
    pos.key = { ...KEY, passphrase: 'Wr0ng-p@ssphrase' };
    const wrong = await pos.send(pos.message('Diagnosis', {}, '99'));
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json, { errors: ['Nexo Service: crypto error'], ServiceID: '99' });
    pos.key = null;
    assert.equal((await pos.send(pos.message('Diagnosis', {}))).status, 401, 'clear text refused when a key is set');
  }));

test('a missing field is a MessageFormat error naming it; bad JSON is rejected', () =>
  withTerminal(async (pos) => {
    const message = pos.payment(5);
    delete (message.PaymentRequest as any).PaymentTransaction.AmountsReq.Currency;
    const r = (await pos.send(message)).json.PaymentResponse.Response;
    assert.equal(r.ErrorCondition, 'MessageFormat');
    assert.equal(additional(r.AdditionalResponse).errors, 'At SaleToPOIRequest.PaymentRequest.PaymentTransaction.AmountsReq, field Currency: Missing');
    assert.equal((await pos.raw('{nope')).status, 400);
  }));

test('unreferenced refund: the shopper presents the card, the response says REFUND', () =>
  withTerminal(async (pos) => {
    pos.terminal.setBehaviour({ shopper: 'auto' });
    const r = (await pos.send(pos.payment(20, 'R1', 'EUR', 'Refund'))).json.PaymentResponse;
    assert.equal(r.Response.Result, 'Success');
    assert.equal(additional(r.Response.AdditionalResponse).transactionType, 'REFUND');
    assert.equal(pos.terminal.snapshot().transactions[0].kind, 'refund');
  }));

test('referenced refund: partial, then the rest, then nothing left', () =>
  withTerminal(async (pos) => {
    pos.terminal.setBehaviour({ shopper: 'auto' });
    const paid = (await pos.send(pos.payment(30))).json.PaymentResponse.POIData.POITransactionID.TransactionID;
    const partial = (await pos.send(pos.reversal(paid, 10, 'V1'))).json.ReversalResponse;
    assert.equal(partial.Response.Result, 'Success');
    assert.equal(partial.ReversedAmount, 10);
    assert.match(partial.POIData.POITransactionID.TransactionID, /^[A-Z0-9]{16}$/, 'the refund has its own pspReference');
    assert.equal(additional(partial.Response.AdditionalResponse).originalReference, paid.split('.')[1]);
    const rest = (await pos.send(pos.reversal(paid))).json.ReversalResponse;
    assert.equal(rest.Response.Result, 'Success');
    assert.equal(additional(rest.Response.AdditionalResponse).posAuthAmountValue, '2000', 'the remaining 20.00');
    const again = (await pos.send(pos.reversal(paid))).json.ReversalResponse;
    assert.equal(again.Response.Result, 'Failure');
    assert.equal(additional(again.Response.AdditionalResponse).message, 'Transaction is already voided');
    const status = (await pos.send(pos.message('TransactionStatus', { MessageReference: { MessageCategory: 'Reversal', SaleID: 'POS1', ServiceID: 'V1' } }))).json.TransactionStatusResponse;
    assert.equal(status.RepeatedMessageResponse.RepeatedResponseMessageBody.ReversalResponse.ReversedAmount, 10);
  }));

test('the transaction record survives a restart of the lab', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'psbx-term-'));
  await withTerminal(async (pos) => {
    pos.terminal.setBehaviour({ shopper: 'auto' });
    await pos.send(pos.payment(4, 'P1'));
  }, dir);
  await withTerminal(async (pos) => {
    const status = (await pos.send(pos.message('TransactionStatus', { MessageReference: { MessageCategory: 'Payment', SaleID: 'POS1', ServiceID: 'P1' } }))).json.TransactionStatusResponse;
    assert.equal(status.Response.Result, 'Success');
    assert.equal(pos.terminal.snapshot().transactions.length, 1);
  }, dir);
});

test('display notifications reach the POS in the order of the payment', async () => {
  const events: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const ref = JSON.parse(body).SaleToPOIRequest.DisplayRequest.DisplayOutput[0].OutputContent.PredefinedContent.ReferenceID;
      events.push(new URLSearchParams(ref).get('event')!);
      res.writeHead(202).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await withTerminal(async (pos, lab) => {
      await lab.lab.updateTerminalConfig('counter', { notificationUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events` });
      const pending = pos.send(pos.payment(60));
      await until(() => pos.terminal.status().screen.phase === 'card');
      pos.terminal.present('maestro', 'ICC');
      await until(() => pos.terminal.status().screen.message === 'Enter PIN');
      for (const k of ['1', '2', '3', '4', 'enter']) pos.terminal.key(k);
      await pending;
      pos.terminal.removeCard();
      await until(() => events.includes('CARD_REMOVED'));
    });
  } finally {
    server.close();
  }
  assert.deepEqual(events, ['TENDER_CREATED', 'CARD_INSERTED', 'WAIT_FOR_PIN', 'PIN_DIGIT_ENTERED', 'PIN_DIGIT_ENTERED', 'PIN_DIGIT_ENTERED', 'PIN_DIGIT_ENTERED', 'PIN_ENTERED', 'TENDER_FINAL', 'CARD_REMOVED']);
});

test('the issuer never answers: after the timeout the payment is declined', () =>
  withTerminal(async (pos) => {
    pos.terminal.setBehaviour({ shopper: 'auto', issuer: 'timeout' });
    const r = (await pos.send(pos.payment(5))).json.PaymentResponse.Response;
    assert.equal(r.Result, 'Failure');
    assert.equal(r.ErrorCondition, 'Communication timeout');
  }));
