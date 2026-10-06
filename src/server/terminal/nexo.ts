import { randomBytes, randomInt } from 'node:crypto';
import { ISSUER_OUTCOMES, TEST_CARDS, type EntryMode, type IssuerOutcomeCode, type TerminalBehaviour, type TestCardId } from '../../shared/contract.ts';

// Terminal API (nexo 3.0) message bodies as an Adyen terminal produces them in a local integration.
// Shapes, key names, ordering and encoding follow real terminal responses
// (a decrypted P400Plus response and the docs' approved/declined examples).

export type Json = Record<string, unknown>;
export type Card = (typeof TEST_CARDS)[number];

export const MERCHANT = { id: 'POSandboxMerchant', store: 'POSandboxStore', mid: '1000', header1: 'POSandbox', header2: 'POS device lab' };

/** Percent-encoding of Adyen's key=value strings: everything but unreserved characters, lowercase hex (`%2a`, `%3a`). */
export const enc = (s: string) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)
    .replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());

export const form = (pairs: Record<string, string | number | boolean>) =>
  Object.entries(pairs)
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join('&');

/** Adyen pspReference: 16 upper-case alphanumerics. */
export const pspReference = () => Array.from(randomBytes(16), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

export const maskedPan = (pan: string) => `${pan.slice(0, 6)} **** ${pan.slice(-4)}`;
export const card = (id: TestCardId) => TEST_CARDS.find((c) => c.id === id)!;

/** Minor units: 10.99 EUR → 1099 (all supported test currencies have two decimals). */
export const minor = (amount: number) => Math.round(amount * 100);

export type Outcome =
  | { kind: 'approved' }
  | { kind: 'failure'; errorCondition: 'Refusal' | 'InvalidCard' | 'WrongPIN' | 'Cancel' | 'Aborted' | 'Communication timeout'; refusalReason: string; message: string };

/** What the issuer answers. Adyen's test rules: the last three digits of the amount (minor units). */
export function issuerOutcome(amount: number, issuer: TerminalBehaviour['issuer']): Outcome {
  if (issuer === 'approve') return { kind: 'approved' };
  if (issuer === 'timeout') return ISSUER_TIMEOUT;
  const code = (issuer === 'amount' ? String(minor(amount) % 1000).padStart(3, '0') : issuer) as IssuerOutcomeCode;
  const rule = ISSUER_OUTCOMES[code];
  if (!rule) return { kind: 'approved' };
  const [errorCondition, refusalReason, message] = rule;
  return { kind: 'failure', errorCondition, refusalReason, message };
}

export const SHOPPER_CANCEL: Outcome = { kind: 'failure', errorCondition: 'Cancel', refusalReason: '108 Shopper cancelled tx', message: '108 Shopper cancelled tx' };
export const PIN_CANCEL: Outcome = { kind: 'failure', errorCondition: 'Cancel', refusalReason: '102 Shopper cancelled pin entry', message: 'Shopper cancelled pin entry' };
export const MERCHANT_ABORT: Outcome = { kind: 'failure', errorCondition: 'Aborted', refusalReason: '104 Merchant cancelled tx', message: '104 Merchant cancelled tx' };
/** Adyen's docs show this ErrorCondition, which is not in their libraries' enum; confirm on a real terminal */
export const ISSUER_TIMEOUT: Outcome = { kind: 'failure', errorCondition: 'Communication timeout', refusalReason: 'Communication timeout', message: 'Communication timeout' };
export const PIN_TRIES: Outcome = { kind: 'failure', errorCondition: 'Refusal', refusalReason: '128 Online PIN tries exceeded', message: 'PIN_TRIES_EXCEEDED' };

const ENTRY: Record<EntryMode, { pos: string; receipt: string }> = {
  Contactless: { pos: 'CLESS_CHIP', receipt: 'Contactless chip' },
  ICC: { pos: 'ICC', receipt: 'Chip' },
  MagStripe: { pos: 'MAGSTRIPE', receipt: 'Magnetic stripe' }, // Value not seen in a real response
};

export interface Sale {
  saleId: string;
  serviceId: string;
  saleTransactionId: string;
  saleTimeStamp: string;
  amount: number;
  currency: string;
}

export interface Tx {
  /** refund: an unreferenced refund (PaymentType Refund), the shopper presents the card. */
  kind: 'payment' | 'refund';
  poiid: string;
  /** Tender reference, e.g. 4r7i001557325515012. */
  tender: string;
  at: Date;
  sale: Sale;
  card: Card | null;
  entry: EntryMode | null;
  pin: boolean;
}

/** Serial's last 8 digits: the terminal id (tid) on receipts and in AdditionalResponse. */
const tid = (poiid: string) => poiid.split('-')[1].slice(-8);

const txdate = (d: Date) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
const txtime = (d: Date) => d.toTimeString().slice(0, 8);
const symbol = (currency: string) => ({ EUR: '€', GBP: '£', USD: '$' })[currency] ?? currency;

/** PaymentResponse body (without the header) for a finished payment. */
export function paymentResponse(tx: Tx, outcome: Outcome): Json {
  const { sale, card: c, entry } = tx;
  const at = tx.at.toISOString();
  const value = minor(sale.amount);
  const common = {
    posAmountCashbackValue: 0,
    posAmountGratuityValue: 0,
    posAuthAmountCurrency: sale.currency,
    posAuthAmountValue: value,
    posOriginalAmountValue: value,
    merchantReference: sale.saleTransactionId,
    store: MERCHANT.store,
    tid: tid(tx.poiid),
    // 'REFUND' for unreferenced refunds is inferred (docs only show GOODS_SERVICES)
    transactionType: tx.kind === 'refund' ? 'REFUND' : 'GOODS_SERVICES',
    iso8601TxDate: at,
    txdate: txdate(tx.at),
    txtime: txtime(tx.at),
  };
  const cardData = c && entry
    ? {
        CardCountryCode: '528',
        EntryMode: [entry],
        MaskedPan: maskedPan(c.pan),
        PaymentBrand: c.brand,
        SensitiveCardData: { CardSeqNumb: '01', ExpiryDate: c.expiry },
      }
    : {};
  const saleData = { SaleTransactionID: { TimeStamp: sale.saleTimeStamp, TransactionID: sale.saleTransactionId } };

  if (outcome.kind === 'failure') {
    return {
      POIData: { POIReconciliationID: '1000', POITransactionID: { TimeStamp: at, TransactionID: tx.tender } },
      PaymentResult: { PaymentAcquirerData: { AcquirerPOIID: tx.poiid, MerchantID: MERCHANT.id }, PaymentInstrumentData: { CardData: cardData, PaymentInstrumentType: 'Card' } },
      Response: {
        AdditionalResponse: form({ batteryLevel: '100%', giftcardIndicator: false, installments: -1, ...common, message: outcome.message, refusalReason: outcome.refusalReason }),
        ErrorCondition: outcome.errorCondition,
        Result: 'Failure',
      },
      SaleData: saleData,
    };
  }

  const psp = pspReference();
  const authCode = String(randomInt(100000, 1000000));
  const expiry = c!.expiry;
  return {
    POIData: { POIReconciliationID: '1000', POITransactionID: { TimeStamp: at, TransactionID: `${tx.tender}.${psp}` } },
    PaymentReceipt: receipts(tx, authCode),
    PaymentResult: {
      AmountsResp: { AuthorizedAmount: sale.amount, Currency: sale.currency },
      ...(tx.pin ? { AuthenticationMethod: [entry === 'ICC' ? 'OfflinePIN' : 'OnlinePIN'] } : {}),
      OnlineFlag: true,
      PaymentAcquirerData: {
        AcquirerPOIID: tx.poiid,
        AcquirerTransactionID: { TimeStamp: at, TransactionID: psp },
        ApprovalCode: authCode,
        MerchantID: MERCHANT.id,
      },
      PaymentInstrumentData: { CardData: cardData, PaymentInstrumentType: 'Card' },
    },
    Response: {
      AdditionalResponse: form({
        ...(c!.aid ? { AID: c!.aid } : {}),
        authCode,
        cardBin: c!.pan.slice(0, 6),
        cardScheme: c!.brand,
        cardSummary: c!.pan.slice(-4),
        cardType: c!.brand,
        expiryMonth: expiry.slice(0, 2),
        expiryYear: `20${expiry.slice(2)}`,
        fundingSource: c!.funding,
        ...common,
        mid: MERCHANT.mid,
        offline: false,
        paymentMethod: c!.brand,
        paymentMethodVariant: c!.brand,
        posEntryMode: ENTRY[entry!].pos,
        pspReference: psp,
        refusalReasonRaw: 'APPROVED',
        shopperCountry: 'NL',
        tc: randomBytes(8).toString('hex').toUpperCase(),
        transactionReferenceNumber: psp,
      }),
      Result: 'Success',
    },
    SaleData: saleData,
  };
}

export const receipts = (tx: Tx, authCode: string) => [receipt('CashierReceipt', tx, authCode), receipt('CustomerReceipt', tx, authCode)];

/** ReversalResponse for a referenced refund (no shopper): the refund's own pspReference identifies it. */
export function reversalResponse(o: { tx: Tx; original: { TransactionID: string; TimeStamp: string }; reversed: number | null; psp: string }): Json {
  const at = o.tx.at.toISOString();
  return {
    POIData: { POIReconciliationID: '1000', POITransactionID: { TimeStamp: at, TransactionID: o.psp } },
    OriginalPOITransaction: { POITransactionID: o.original },
    PaymentReceipt: receipts(o.tx, ''),
    ...(o.reversed !== null ? { ReversedAmount: o.reversed } : {}),
    Response: {
      AdditionalResponse: form({
        iso8601TxDate: at,
        merchantReference: o.tx.sale.saleTransactionId,
        originalReference: o.original.TransactionID.split('.').pop()!,
        posAuthAmountCurrency: o.tx.sale.currency,
        posAuthAmountValue: minor(o.tx.sale.amount),
        pspReference: o.psp,
        store: MERCHANT.store,
        tid: tid(o.tx.poiid),
        transactionType: 'REFUND',
        txdate: txdate(o.tx.at),
        txtime: txtime(o.tx.at),
      }),
      Result: 'Success',
    },
  };
}

/** Receipt lines in the order and encoding of a real P400Plus (cashier and cardholder copies). */
function receipt(qualifier: 'CashierReceipt' | 'CustomerReceipt', tx: Tx, authCode: string): Json {
  const c = tx.card!;
  const d = tx.at;
  const line = (pairs: Record<string, string>, bold = false) => ({ ...(bold ? { CharacterStyle: 'Bold' } : {}), EndOfLineFlag: true, Text: form(pairs) });
  const filler = line({ key: 'filler' });
  const cashier = qualifier === 'CashierReceipt';
  const amount = `${symbol(tx.sale.currency)} ${tx.sale.amount.toFixed(2)}`;
  const lines = [
    line({ name: MERCHANT.header1, key: 'header1' }, true),
    line({ name: MERCHANT.header2, key: 'header2' }, true),
    cashier ? line({ name: 'MERCHANT COPY', key: 'merchantTitle' }, true) : line({ name: 'CARDHOLDER COPY', key: 'cardholderHeader' }, true),
    filler,
    line({ name: 'Date', value: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`, key: 'txdate' }),
    line({ name: 'Time', value: txtime(d), key: 'txtime' }),
    filler,
    line({ name: 'Card', value: `${'*'.repeat(c.pan.length - 4)}${c.pan.slice(-4)}`, key: 'pan' }),
    line({ name: 'PAN seq.', value: '01', key: 'panSeq' }),
    line({ name: 'Card type', value: c.brand, key: 'cardType' }),
    line({ name: 'Payment method', value: c.brand, key: 'paymentMethod' }),
    line({ name: 'Payment variant', value: c.brand, key: 'paymentMethodVariant' }),
    line({ name: 'Entry mode', value: ENTRY[tx.entry!].receipt, key: 'posEntryMode' }),
    ...(tx.pin ? [line({ name: 'Verification', value: 'PIN', key: 'cvmRes' })] : []),
    filler,
    ...(c.aid ? [line({ name: 'AID', value: c.aid, key: 'aid' })] : []),
    line({ name: 'MID', value: MERCHANT.mid, key: 'mid' }),
    line({ name: 'TID', value: tx.poiid, key: 'tid' }),
    line({ name: 'PTID', value: tid(tx.poiid), key: 'ptid' }),
    filler,
    ...(authCode ? [line({ name: 'Auth. code', value: authCode, key: 'authCode' })] : []),
    line({ name: 'Tender', value: tx.tender, key: 'txRef' }),
    line({ name: 'Reference', value: tx.sale.saleTransactionId, key: 'mref' }),
    filler,
    line({ name: 'Type', value: tx.kind === 'refund' ? 'REFUND' : 'GOODS_SERVICES', key: 'txtype' }),
    line({ name: 'TOTAL', value: amount, key: 'totalAmount' }, true),
    filler,
    line({ name: 'APPROVED', key: 'approved' }, true),
    ...(cashier ? [] : [filler, line({ name: 'Please retain for your records', key: 'retain' }), line({ name: 'Thank you', key: 'thanks' })]),
  ];
  return { DocumentQualifier: qualifier, OutputContent: { OutputFormat: 'Text', OutputText: lines }, RequiredSignatureFlag: false };
}
