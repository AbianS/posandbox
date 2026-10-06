import type {
  EntryMode,
  InspectorEntry,
  TerminalBehaviour,
  TerminalConfig,
  TerminalEvent,
  TerminalScreen,
  TerminalSnapshot,
  TerminalStatus,
  TerminalTransaction,
  TestCardId,
} from '../../shared/contract.ts';
import { decrypt, encrypt, type Envelope } from './nexo-crypto.ts';
import {
  card as testCard,
  form,
  issuerOutcome,
  MERCHANT,
  MERCHANT_ABORT,
  minor,
  PIN_CANCEL,
  PIN_TRIES,
  paymentResponse,
  pspReference,
  reversalResponse,
  SHOPPER_CANCEL,
  type Card,
  type Json,
  type Outcome,
  type Sale,
  type Tx,
} from './nexo.ts';

/** What the HTTPS side sends back: a response, or nothing at all (the connection is dropped). */
export type Reply = { status: number; body: string } | 'drop';

/** Durations of the terminal, in ms. Tests pass shorter ones. */
export interface Timing {
  read: Record<EntryMode, number>;
  authorize: number;
  result: number;
  pinError: number;
  cardTimeout: number;
  pinTimeout: number;
  /** Auto shopper: delay before tapping the card, and between PIN digits. */
  autoShopper: number;
  /** The issuer never answers (Adyen: 120 s in a local integration). */
  issuerTimeout: number;
}

export const REAL_TIMING: Timing = {
  read: { Contactless: 500, ICC: 1500, MagStripe: 600 },
  authorize: 1800,
  result: 4000,
  pinError: 2000,
  cardTimeout: 120_000,
  pinTimeout: 60_000,
  autoShopper: 1200,
  issuerTimeout: 120_000,
};

/** What the terminal keeps across restarts: its transaction record. */
export interface TerminalState {
  history: [string, { header: Header; body: Json }][];
  transactions: TerminalTransaction[];
  approved: Approved[];
  last: { saleId: string; serviceId: string } | null;
  tenderSeq: number;
}

export interface TerminalPersistence {
  load(): TerminalState | null;
  save(state: TerminalState): void;
}

/** An approved payment that a ReversalRequest can refund. */
interface Approved {
  psp: string;
  id: string;
  at: string;
  sale: Sale;
  card: TestCardId;
  entry: EntryMode;
  refunded: number;
}

const PIN = '1234';
const MAX_PIN_TRIES = 3;
/** Spanish contactless CVM limit for every test card; per-scheme limits if a POS needs them */
const CONTACTLESS_CVM_LIMIT = 50;
const HISTORY = 200;
const INSPECTOR_SIZE = 400;

const IDLE: TerminalScreen = { phase: 'idle', operation: null, amount: null, message: 'Welcome', pinDigits: 0, result: null };

interface Header {
  ProtocolVersion?: string;
  MessageClass?: string;
  MessageCategory?: string;
  MessageType?: string;
  SaleID?: string;
  ServiceID?: string;
  POIID?: string;
}

interface Current {
  kind: 'payment' | 'refund';
  header: Header;
  sale: Sale;
  tender: string;
  at: Date;
  encrypted: boolean;
  resolve: (reply: Reply) => void;
  card: Card | null;
  entry: EntryMode | null;
  pin: string;
  pinNeeded: boolean;
  pinTries: number;
  /** The issuer answered "wrong PIN": the terminal asks again; cancelling ends with that outcome. */
  wrongPin: Outcome | null;
}

/**
 * Virtual Adyen payment terminal (Terminal API, local integration). It owns what the POS can observe: one
 * transaction at a time, the shopper's interaction and the record that TransactionStatus answers from.
 */
export class Terminal {
  config: TerminalConfig;
  readonly #emit: (event: TerminalEvent) => void;
  readonly #timing: Timing;

  #network = { listening: false, listenError: null as string | null };
  #behaviour: TerminalBehaviour = { shopper: 'manual', issuer: 'amount', responseLost: false };
  #screen: TerminalScreen = IDLE;
  #cardInserted: TestCardId | null = null;
  #current: Current | null = null;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #resultTimer: ReturnType<typeof setTimeout> | undefined;

  /** Finished messages by `<category>/<SaleID>/<ServiceID>`, for TransactionStatus. */
  #history = new Map<string, { header: Header; body: Json }>();
  #last: { saleId: string; serviceId: string } | null = null;
  #transactions: TerminalTransaction[] = [];
  #approved = new Map<string, Approved>();
  #tenderSeq = 0;
  #reversing: Header | null = null;
  readonly #persistence: TerminalPersistence | null;
  #deviceSeq = 0;
  /** Display notifications go out one after another, so the POS sees them in the order of the payment. */
  #notifications: Promise<void> = Promise.resolve();

  #inspector: InspectorEntry[] = [];
  #inspectorSeq = 0;
  #newEntries: InspectorEntry[] = [];
  #lastStatus = '';

  constructor(config: TerminalConfig, emit: (event: TerminalEvent) => void, timing: Timing = REAL_TIMING, persistence: TerminalPersistence | null = null) {
    this.config = config;
    this.#emit = emit;
    this.#timing = timing;
    this.#persistence = persistence;
    const saved = persistence?.load();
    if (saved) {
      this.#history = new Map(saved.history);
      this.#transactions = saved.transactions;
      this.#approved = new Map(saved.approved.map((a) => [a.psp, a]));
      this.#last = saved.last;
      this.#tenderSeq = saved.tenderSeq;
    }
    this.#lastStatus = JSON.stringify(this.status());
  }

  status(): TerminalStatus {
    const c = this.#current;
    const presented = c?.card && c.entry ? { card: c.card.id, entry: c.entry } : null;
    return { ...this.#network, screen: this.#screen, behaviour: { ...this.#behaviour }, presented, cardInserted: this.#cardInserted };
  }

  snapshot(): TerminalSnapshot {
    return { config: this.config, status: this.status(), transactions: [...this.#transactions], inspector: [...this.#inspector] };
  }

  // ---- Terminal API over HTTPS ----

  async handle(raw: string, peer: string): Promise<Reply> {
    let root: Record<string, unknown>;
    try {
      root = (JSON.parse(raw) as { SaleToPOIRequest?: Record<string, unknown> }).SaleToPOIRequest!;
      if (!root || typeof root !== 'object') throw new Error('SaleToPOIRequest missing');
    } catch (error) {
      // HTTP status of "Bad JSON" is not documented; 400 until a real terminal says otherwise
      this.#log('rx', `${peer}: Invalid JSON`, raw);
      return this.#plain(400, [`Bad JSON:1: ${(error as Error).message}`]);
    }

    const key = this.config.sharedKey;
    const encrypted = 'NexoBlob' in root;
    if (encrypted || key) {
      // A clear request to a terminal with a key gets the crypto error too (not documented)
      const plain = encrypted && key ? decrypt(root as unknown as Envelope, key) : null;
      const serviceId = (root.MessageHeader as Header | undefined)?.ServiceID;
      if (!plain) {
        this.#log('rx', `${peer}: ${encrypted ? (key ? 'incorrect key or HMAC' : 'encrypted message, but the terminal has no key') : 'unencrypted message; the terminal requires a key'}`, raw);
        return this.#plain(401, { errors: ['Nexo Service: crypto error'], ServiceID: serviceId });
      }
      root = (JSON.parse(plain) as { SaleToPOIRequest: Record<string, unknown> }).SaleToPOIRequest;
    }

    const header = (root.MessageHeader ?? {}) as Header;
    const category = header.MessageCategory ?? '?';
    this.#log('rx', `${category} ${header.MessageType ?? ''} · ServiceID ${header.ServiceID ?? '—'}${encrypted ? ' · encrypted' : ''}`, JSON.stringify({ SaleToPOIRequest: root }, null, 2));

    if (header.ProtocolVersion !== '3.0') {
      return this.#reply(header, failure('UnavailableService', form({ message: `Sale Protocol Version ${header.ProtocolVersion} mismatch, Version implemented: 3.0` })), encrypted);
    }
    if ((this.#current || this.#reversing) && category !== 'Abort' && category !== 'TransactionStatus') return this.#reply(header, this.#busy(), encrypted);
    switch (category) {
      case 'Payment': return this.#payment(header, root.PaymentRequest as Json | undefined, encrypted);
      case 'Abort':
        this.#abort(root.AbortRequest as Json | undefined);
        this.#flush();
        return { status: 200, body: '' };
      case 'TransactionStatus': return this.#reply(header, this.#transactionStatus(root.TransactionStatusRequest as Json | undefined), encrypted);
      case 'Diagnosis': return this.#reply(header, this.#diagnosis(root.DiagnosisRequest as Json | undefined), encrypted);
      case 'Reversal': return this.#reversal(header, root.ReversalRequest as Json | undefined, encrypted);
      default: return this.#reply(header, failure('UnavailableService', form({ message: `${category} is not supported by POSandbox` })), encrypted);
    }
  }

  #payment(header: Header, request: Json | undefined, encrypted: boolean): Promise<Reply> | Reply {
    const sale = get(request, 'SaleData', 'SaleTransactionID') as Json | undefined;
    const amounts = get(request, 'PaymentTransaction', 'AmountsReq') as Json | undefined;
    const missing = (path: string, field: string) => this.#reply(header, failure('MessageFormat', form({ errors: `At SaleToPOIRequest.PaymentRequest${path}, field ${field}: Missing` })), encrypted);
    if (!request) return this.#reply(header, failure('MessageFormat', form({ errors: 'At SaleToPOIRequest, field PaymentRequest: Missing' })), encrypted);
    if (typeof sale?.TransactionID !== 'string') return missing('.SaleData.SaleTransactionID', 'TransactionID');
    if (typeof sale?.TimeStamp !== 'string') return missing('.SaleData.SaleTransactionID', 'TimeStamp');
    if (typeof amounts?.Currency !== 'string') return missing('.PaymentTransaction.AmountsReq', 'Currency');
    if (typeof amounts?.RequestedAmount !== 'number' || amounts.RequestedAmount <= 0) return missing('.PaymentTransaction.AmountsReq', 'RequestedAmount');
    const kind = get(request, 'PaymentData', 'PaymentType') === 'Refund' ? 'refund' : 'payment';

    clearTimeout(this.#resultTimer);
    if (this.#cardInserted) this.#cardInserted = null; // The previous chip card is taken out on its own
    const at = new Date();
    return new Promise<Reply>((resolve) => {
      this.#current = {
        kind, header, encrypted, resolve, at,
        tender: this.#tender(at),
        sale: { saleId: header.SaleID ?? '', serviceId: header.ServiceID ?? '', saleTransactionId: sale.TransactionID as string, saleTimeStamp: sale.TimeStamp as string, amount: amounts.RequestedAmount as number, currency: amounts.Currency as string },
        card: null, entry: null, pin: '', pinNeeded: false, pinTries: 0, wrongPin: null,
      };
      this.#show({ phase: 'card', operation: kind, message: 'Tap, insert or swipe card' });
      this.#notify('TENDER_CREATED');
      this.#after(this.#timing.cardTimeout, () => this.#finish(SHOPPER_CANCEL));
      if (this.#behaviour.shopper === 'auto') this.#after(this.#timing.autoShopper, () => this.present('visa', 'Contactless'));
      this.#flush();
    });
  }

  #abort(request: Json | undefined): void {
    const ref = request?.MessageReference as Json | undefined;
    const current = this.#current;
    if (!current || (ref && (ref.ServiceID !== current.header.ServiceID || (ref.SaleID !== undefined && ref.SaleID !== current.header.SaleID)))) {
      this.#log('info', 'Abort without a matching active transaction: ignored');
      return;
    }
    this.#log('info', `Abort from POS (${String(request?.AbortReason ?? 'no reason')})`);
    // before a card is presented the payment screen just disappears; afterwards the terminal shows "Cancelled"
    this.#finish(MERCHANT_ABORT, current.card === null);
  }

  #transactionStatus(request: Json | undefined): Json {
    const ref = request?.MessageReference as Json | undefined;
    const current = this.#current;
    if (current && (!ref || (ref.ServiceID === current.header.ServiceID && ref.SaleID === current.header.SaleID))) {
      const detailed = { card: 'TENDER_CREATED', reading: 'CARD_INSERTED', pin: 'WAIT_FOR_PIN', authorizing: 'PIN_ENTERED' }[this.#screen.phase as string] ?? 'TENDER_CREATED';
      return {
        MessageReference: { MessageCategory: 'Payment', SaleID: current.header.SaleID, ServiceID: current.header.ServiceID },
        Response: { AdditionalResponse: form({ detailedStatus: detailed, status: 'Uncompleted transaction', tenderReference: current.tender }), ErrorCondition: 'InProgress', Result: 'Failure' },
      };
    }
    const category = (ref?.MessageCategory as string | undefined) ?? 'Payment';
    const found = ref && this.#history.get(`${category}/${ref.SaleID}/${ref.ServiceID}`);
    if (found) {
      return {
        MessageReference: { MessageCategory: category, SaleID: ref.SaleID, ServiceID: ref.ServiceID },
        RepeatedMessageResponse: { MessageHeader: found.header, RepeatedResponseMessageBody: { [`${category}Response`]: found.body } },
        Response: { Result: 'Success' },
      };
    }
    const last = this.#last ? `, last such Request has SaleID=${this.#last.saleId} ServiceID=${this.#last.serviceId}` : '';
    return { Response: { AdditionalResponse: form({ message: `Message not found. Category=${category}${last}` }), ErrorCondition: 'NotFound', Result: 'Failure' } };
  }

  #diagnosis(request: Json | undefined): Json {
    return {
      POIStatus: { CommunicationOKFlag: true, GlobalStatus: 'OK', PrinterStatus: 'OK' },
      ...(request?.HostDiagnosisFlag ? { HostStatus: [{ AcquirerID: '0', IsReachableFlag: true }] } : {}),
      Response: {
        AdditionalResponse: form({ batteryLevel: '100%', firmwareVersion: 'adyen_v1_49p5', merchantAccount: MERCHANT.id, storeId: MERCHANT.store, terminalId: this.config.poiid, unconfirmedBatchCount: 0 }),
        Result: 'Success',
      },
    };
  }

  /** Shape inferred from the docs' message text; the exact JSON of a real Busy reply is not documented */
  #busy(): Json {
    const serviceId = this.#current?.header.ServiceID ?? this.#reversing?.ServiceID ?? '';
    const dialogue = this.#current ? 'PaymentRequest' : 'ReversalRequest';
    return failure('Busy', form({ message: `Forbidden Request, Service Dialogue ${dialogue} is in Progress`, serviceId }));
  }

  /** `<Category>Response` with the request header echoed (MessageType: Response), encrypted like the request. */
  #reply(header: Header, body: Json, encrypted: boolean): Reply {
    const message = { MessageHeader: { ...header, MessageType: 'Response' }, [`${header.MessageCategory ?? 'Payment'}Response`]: body };
    const response = (body.Response as Json | undefined) ?? {};
    this.#log('tx', `${header.MessageCategory ?? '?'}Response · ${response.Result ?? ''}${response.ErrorCondition ? ` / ${response.ErrorCondition}` : ''}`, JSON.stringify({ SaleToPOIResponse: message }, null, 2));
    this.#flush();
    const key = this.config.sharedKey;
    const wire = encrypted && key ? encrypt('SaleToPOIResponse', message, key) : { SaleToPOIResponse: message };
    return { status: 200, body: JSON.stringify(wire) };
  }

  #plain(status: number, body: unknown): Reply {
    this.#log('tx', `HTTP ${status}`, JSON.stringify(body));
    this.#flush();
    return { status, body: JSON.stringify(body) };
  }

  // ---- the shopper (panel, CLI or auto mode) ----

  /** Taps, inserts or swipes a test card. Returns why it was refused, if it was. */
  present(cardId: TestCardId, entry: EntryMode): string | null {
    const current = this.#current;
    const refused = (why: string) => (this.#log('info', `Card not accepted: ${why}`), this.#flush(), why);
    if (!current || this.#screen.phase !== 'card') return refused('terminal is not waiting for a card');
    const c = testCard(cardId);
    if (!(c.entry as readonly EntryMode[]).includes(entry)) return refused(`${c.label} no admite ${entry}`);
    const ending = minor(current.sale.amount) % 1000;
    if (entry === 'Contactless' && this.#behaviour.issuer === 'amount' && (ending === 142 || ending === 143)) {
      this.#show({ message: 'Contactless limit exceeded. Insert card' });
      return refused('contactless limit exceeded');
    }
    current.card = c;
    current.entry = entry;
    current.pinNeeded = entry !== 'Contactless' || current.sale.amount > CONTACTLESS_CVM_LIMIT;
    if (entry === 'ICC') {
      this.#cardInserted = c.id;
      this.#notify('CARD_INSERTED');
    }
    this.#clearTimers();
    this.#log('info', `Tarjeta ${c.label} · ${entry}`);
    this.#show({ phase: 'reading', message: entry === 'ICC' ? 'Reading card. Do not remove' : 'Reading card…' });
    this.#after(this.#timing.read[entry], () => (current.pinNeeded ? this.#askPin() : this.#authorize()));
    this.#flush();
    return null;
  }

  /** A key of the terminal's keypad. */
  key(key: string): void {
    const current = this.#current;
    const phase = this.#screen.phase;
    if (key === 'cancel') {
      if (current && (phase === 'card' || phase === 'reading' || phase === 'pin')) {
        this.#log('info', 'Terminal cancel key');
        this.#finish(current.wrongPin ?? (phase === 'pin' ? PIN_CANCEL : SHOPPER_CANCEL));
      }
      return;
    }
    if (!current || phase !== 'pin' || this.#screen.message !== 'Enter PIN') return;
    if (/^[0-9]$/.test(key) && current.pin.length < 12) {
      current.pin += key;
      this.#notify('PIN_DIGIT_ENTERED');
    }
    else if (key === 'clear') current.pin = current.pin.slice(0, -1);
    else if (key === 'enter' && current.pin.length >= 4) return this.#checkPin();
    this.#show({ pinDigits: current.pin.length });
    this.#flush();
  }

  /** Takes the chip card out of the reader. */
  removeCard(): void {
    if (!this.#cardInserted) return;
    this.#cardInserted = null;
    this.#log('info', 'Card removed');
    this.#notify('CARD_REMOVED');
    this.#flush();
  }

  setBehaviour(patch: Partial<TerminalBehaviour>): void {
    this.#behaviour = { ...this.#behaviour, ...patch };
    this.#flush();
  }

  setNetwork(listening: boolean, listenError: string | null = null): void {
    this.#network = { listening, listenError };
    if (!listening) this.#powerOff();
    this.#flush();
  }

  applyConfig(config: TerminalConfig): void {
    this.config = config;
    this.#emit({ type: 'terminal.config', config });
    this.#flush();
  }

  // ---- flow ----

  #askPin(): void {
    const current = this.#current!;
    current.pin = '';
    this.#show({ phase: 'pin', message: 'Enter PIN', pinDigits: 0 });
    this.#notify('WAIT_FOR_PIN');
    this.#after(this.#timing.pinTimeout, () => this.#finish(current.wrongPin ?? PIN_CANCEL));
    if (this.#behaviour.shopper === 'auto') {
      [...PIN].forEach((digit, i) => this.#after(this.#timing.autoShopper / 4 * (i + 1), () => this.key(digit)));
      this.#after(this.#timing.autoShopper * 1.5, () => this.key('enter'));
    }
    this.#flush();
  }

  #checkPin(): void {
    const current = this.#current!;
    this.#clearTimers();
    if (current.pin === PIN) {
      this.#notify('PIN_ENTERED');
      return this.#authorize();
    }
    if (++current.pinTries >= MAX_PIN_TRIES) return this.#finish(PIN_TRIES);
    this.#log('info', `Incorrect PIN (${MAX_PIN_TRIES - current.pinTries} attempts)`);
    this.#show({ message: 'Incorrect PIN', pinDigits: 0 });
    this.#after(this.#timing.pinError, () => this.#askPin());
    this.#flush();
  }

  #authorize(): void {
    const current = this.#current!;
    this.#show({ phase: 'authorizing', message: 'Authorizing…', pinDigits: 0 });
    this.#after(this.#behaviour.issuer === 'timeout' ? this.#timing.issuerTimeout : this.#timing.authorize, () => {
      const outcome = issuerOutcome(current.sale.amount, this.#behaviour.issuer);
      if (outcome.kind === 'failure' && outcome.errorCondition === 'WrongPIN') {
        // Adyen test terminals show "Incorrect PIN" and ask again until the shopper cancels
        current.wrongPin = outcome;
        this.#show({ phase: 'pin', message: 'Incorrect PIN', pinDigits: 0 });
        this.#after(this.#timing.pinError, () => this.#askPin());
        return this.#flush();
      }
      this.#finish(outcome);
    });
    this.#flush();
  }

  /** Ends the transaction: records it, answers the POS (unless the response is lost) and shows the result. */
  #finish(outcome: Outcome, silent = false): void {
    const current = this.#current;
    if (!current) return;
    this.#clearTimers();
    this.#current = null;
    const tx: Tx = { kind: current.kind, poiid: this.config.poiid, tender: current.tender, at: new Date(), sale: current.sale, card: current.card, entry: current.entry, pin: current.pinNeeded };
    const body = paymentResponse(tx, outcome);
    const header = { ...current.header, MessageType: 'Response' };
    this.#history.set(`Payment/${current.sale.saleId}/${current.sale.serviceId}`, { header, body });

    const poi = (body.POIData as { POITransactionID: { TransactionID: string } }).POITransactionID;
    if (outcome.kind === 'approved' && current.kind === 'payment') {
      const psp = poi.TransactionID.split('.')[1];
      this.#approved.set(psp, { psp, id: poi.TransactionID, at: tx.at.toISOString(), sale: current.sale, card: current.card!.id, entry: current.entry!, refunded: 0 });
    }
    const transaction: TerminalTransaction = {
      kind: current.kind,
      id: poi.TransactionID,
      saleId: current.sale.saleId,
      serviceId: current.sale.serviceId,
      at: new Date().toISOString(),
      amount: current.sale.amount,
      currency: current.sale.currency,
      result: outcome.kind === 'approved' ? 'Success' : 'Failure',
      errorCondition: outcome.kind === 'approved' ? null : outcome.errorCondition,
      detail: outcome.kind === 'approved' ? (current.kind === 'refund' ? 'Refund approved' : 'Approved') : outcome.refusalReason,
      card: current.card && current.entry ? { brand: current.card.brand, maskedPan: `**** ${current.card.pan.slice(-4)}`, entry: current.entry } : null,
      delivered: !this.#behaviour.responseLost,
    };
    this.#record(transaction);
    this.#notify('TENDER_FINAL', { Result: transaction.result, TimeStamp: tx.at.toISOString(), TransactionID: poi.TransactionID }, current.header);

    if (silent) this.#show(IDLE);
    else {
      const result = outcome.kind === 'approved' ? 'approved' : outcome.errorCondition === 'Cancel' || outcome.errorCondition === 'Aborted' ? 'cancelled' : 'declined';
      this.#showResult(result, result === 'approved' ? 'Approved' : result === 'cancelled' ? 'Cancelled' : 'Declined');
    }
    current.resolve(this.#deliver(current.header, body, current.encrypted));
  }

  /** Referenced refund: no shopper, the original payment's pspReference says what to refund. */
  #reversal(header: Header, request: Json | undefined, encrypted: boolean): Reply | Promise<Reply> {
    const original = get(request, 'OriginalPOITransaction', 'POITransactionID') as { TransactionID?: unknown; TimeStamp?: unknown } | undefined;
    if (typeof original?.TransactionID !== 'string') {
      return this.#reply(header, failure('MessageFormat', form({ errors: 'At SaleToPOIRequest.ReversalRequest.OriginalPOITransaction.POITransactionID, field TransactionID: Missing' })), encrypted);
    }
    const psp = original.TransactionID.split('.').pop()!;
    const found = this.#approved.get(psp);
    // The exact failures of a refund on an unknown or spent payment are not documented
    if (!found) return this.#reply(header, failure('NotFound', form({ message: `Original pspReference ${psp} not found` })), encrypted);
    const remaining = Math.round((found.sale.amount - found.refunded) * 100) / 100;
    if (remaining <= 0) return this.#reply(header, failure('Refusal', form({ message: 'Transaction is already voided' })), encrypted);
    const requested = (request as Json).ReversedAmount;
    const reversed = typeof requested === 'number' ? requested : remaining;
    if (reversed <= 0 || reversed > remaining + 1e-9) return this.#reply(header, failure('Refusal', form({ message: `Refund amount ${reversed} exceeds the refundable ${remaining}` })), encrypted);

    const saleTx = get(request, 'SaleData', 'SaleTransactionID') as Json | undefined;
    const sale: Sale = {
      saleId: header.SaleID ?? '', serviceId: header.ServiceID ?? '',
      saleTransactionId: typeof saleTx?.TransactionID === 'string' ? saleTx.TransactionID : found.sale.saleTransactionId,
      saleTimeStamp: typeof saleTx?.TimeStamp === 'string' ? saleTx.TimeStamp : new Date().toISOString(),
      amount: reversed, currency: found.sale.currency,
    };
    this.#reversing = header;
    clearTimeout(this.#resultTimer);
    this.#screen = { ...IDLE, phase: 'authorizing', operation: 'refund', amount: { value: reversed, currency: sale.currency }, message: 'Processing refund…' };
    this.#flush();
    return new Promise<Reply>((resolve) => {
      this.#after(this.#timing.authorize, () => {
        this.#reversing = null;
        found.refunded = Math.round((found.refunded + reversed) * 100) / 100;
        const refundPsp = pspReference();
        const tx: Tx = { kind: 'refund', poiid: this.config.poiid, tender: '', at: new Date(), sale, card: testCard(found.card), entry: found.entry, pin: false };
        const body = reversalResponse({ tx, original: { TransactionID: found.id, TimeStamp: found.at }, reversed: typeof requested === 'number' ? reversed : null, psp: refundPsp });
        this.#history.set(`Reversal/${sale.saleId}/${sale.serviceId}`, { header: { ...header, MessageType: 'Response' }, body });
        this.#record({
          kind: 'reversal', id: refundPsp, saleId: sale.saleId, serviceId: sale.serviceId, at: tx.at.toISOString(), amount: reversed, currency: sale.currency,
          result: 'Success', errorCondition: null, detail: `Reversal of ${found.id}`, card: { brand: tx.card!.brand, maskedPan: `**** ${tx.card!.pan.slice(-4)}`, entry: found.entry },
          delivered: !this.#behaviour.responseLost,
        });
        this.#showResult('approved', 'Refund approved');
        resolve(this.#deliver(header, body, encrypted));
      });
    });
  }

  /** The response, or nothing when the lab is losing responses. */
  #deliver(header: Header, body: Json, encrypted: boolean): Reply {
    if (!this.#behaviour.responseLost) return this.#reply(header, body, encrypted);
    this.#log('info', 'Response lost: the operation is recorded on the terminal, but the POS receives nothing');
    this.#flush();
    return 'drop';
  }

  #showResult(result: 'approved' | 'declined' | 'cancelled', message: string): void {
    this.#show({ phase: 'result', result, message, pinDigits: 0 });
    clearTimeout(this.#resultTimer);
    this.#resultTimer = setTimeout(() => {
      this.#show(IDLE);
      this.#flush();
    }, this.#timing.result);
  }

  /** Adds a finished operation to the record and saves the record (it survives restarts, like the real one). */
  #record(transaction: TerminalTransaction): void {
    this.#last = { saleId: transaction.saleId, serviceId: transaction.serviceId };
    if (this.#history.size > HISTORY) this.#history.delete(this.#history.keys().next().value!);
    this.#transactions = [transaction, ...this.#transactions].slice(0, 100);
    this.#emit({ type: 'terminal.transaction', transaction });
    this.#persistence?.save({
      history: [...this.#history],
      transactions: this.#transactions,
      approved: [...this.#approved.values()].slice(-HISTORY),
      last: this.#last,
      tenderSeq: this.#tenderSeq,
    });
  }

  /**
   * Display notification to the POS (Adyen "Local" event URL), fire and forget with a few retries.
   * Header fields follow the docs' example; DeviceID numbering is ours
   */
  #notify(event: string, extra: Record<string, string> = {}, header: Header | undefined = this.#current?.header): void {
    const url = this.config.notificationUrl;
    if (!url) return;
    const tender = this.#current?.tender;
    const reference = form({ ...(tender && event === 'TENDER_CREATED' ? { TransactionID: tender, TimeStamp: new Date().toISOString() } : {}), ...extra, event });
    const message = {
      MessageHeader: { ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Display', MessageType: 'Request', ServiceID: header?.ServiceID ?? '', DeviceID: String(++this.#deviceSeq), SaleID: header?.SaleID ?? '', POIID: this.config.poiid },
      DisplayRequest: { DisplayOutput: [{ Device: 'CashierDisplay', InfoQualify: 'Status', OutputContent: { OutputFormat: 'MessageRef', PredefinedContent: { ReferenceID: reference } }, ResponseRequiredFlag: false }] },
    };
    const key = this.config.sharedKey;
    const body = JSON.stringify(key ? encrypt('SaleToPOIRequest', message, key) : { SaleToPOIRequest: message });
    const send = async (attempt: number): Promise<void> => {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
        this.#log('tx', `Notification ${event} → ${url} · HTTP ${res.status}`, JSON.stringify({ SaleToPOIRequest: message }, null, 2));
        if (!res.ok && attempt < 3) return void setTimeout(() => send(attempt + 1), 1000 * attempt);
      } catch (error) {
        this.#log('info', `Notification ${event} not delivered (${attempt}/3): ${(error as Error).message}`);
        if (attempt < 3) setTimeout(() => send(attempt + 1), 1000 * attempt);
      }
      this.#flush();
    };
    // ponytail: retries leave the queue (a dead URL must not hold back later events), so only they can arrive late
    this.#notifications = this.#notifications.then(() => send(1));
  }

  /** Power cut or listener closed: a payment not yet authorised is lost, as on a terminal that reboots. */
  #powerOff(): void {
    const current = this.#current;
    this.#clearTimers();
    clearTimeout(this.#resultTimer);
    this.#current = null;
    this.#reversing = null;
    this.#cardInserted = null;
    this.#screen = IDLE;
    if (current) {
      this.#log('info', 'Terminal powered off during a transaction: transaction lost');
      current.resolve('drop');
    }
  }

  // ---- helpers ----

  #tender(at: Date): string {
    // Observed pattern (4 chars + 00 + epoch seconds + 3-digit counter), not a documented rule
    const code = (Number(this.config.poiid.split('-')[1] ?? 0) % 36 ** 4).toString(36).padStart(4, '0');
    return `${code}00${Math.floor(at.getTime() / 1000)}${String(++this.#tenderSeq % 1000).padStart(3, '0')}`;
  }

  #show(patch: Partial<TerminalScreen>): void {
    const amount = this.#current ? { value: this.#current.sale.amount, currency: this.#current.sale.currency } : this.#screen.amount;
    this.#screen = { ...this.#screen, amount, ...patch };
  }

  #after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, ms);
    this.#timers.add(timer);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #log(kind: InspectorEntry['kind'], label: string, body?: string): void {
    const entry: InspectorEntry = { seq: ++this.#inspectorSeq, at: new Date().toISOString(), kind, label, hex: '' };
    if (body) entry.body = body;
    this.#inspector.push(entry);
    if (this.#inspector.length > INSPECTOR_SIZE) this.#inspector.splice(0, this.#inspector.length - INSPECTOR_SIZE);
    this.#newEntries.push(entry);
  }

  #flush(): void {
    const status = JSON.stringify(this.status());
    if (status !== this.#lastStatus) {
      this.#lastStatus = status;
      this.#emit({ type: 'terminal.status', status: this.status() });
    }
    if (this.#newEntries.length) {
      this.#emit({ type: 'terminal.inspector', entries: this.#newEntries });
      this.#newEntries = [];
    }
  }
}

function failure(errorCondition: string, additional: string): Json {
  return { Response: { AdditionalResponse: additional, ErrorCondition: errorCondition, Result: 'Failure' } };
}

function get(value: unknown, ...path: string[]): unknown {
  let v = value;
  for (const k of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}
