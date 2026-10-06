// Control contract between the lab engine and the web panel.
// Every device lives under its own key (`printers` today; drawers, scales... later),
// and every event carries the id of the device it belongs to.

/** headOverheat: auto-recoverable error (offline until it cools down). */
export const PRINTER_FAULTS = ['paperNearEnd', 'paperOut', 'coverOpen', 'headOverheat'] as const;
export type PrinterFault = (typeof PRINTER_FAULTS)[number];

export const PAPER_WIDTHS = [80, 58] as const;
export type PaperWidth = (typeof PAPER_WIDTHS)[number];

/** Persistent settings. Changing `port` or `paperWidth` restarts the virtual printer. */
export interface PrinterConfig {
  id: string;
  name: string;
  enabled: boolean;
  port: number;
  paperWidth: PaperWidth;
}

export type TicketEnd = 'cut' | 'partial-cut' | 'torn' | 'power-off';

export interface TicketInfo {
  id: string;
  printerId: string;
  startedAt: string;
  /** Null while the paper is still in the printer. */
  endedAt: string | null;
  end: TicketEnd | null;
  widthDots: number;
  heightDots: number;
  /** Height limit reached: content beyond it was not rasterised. */
  truncated: boolean;
}

export interface PrinterStatus {
  /** TCP listener open (virtual printer powered on). */
  listening: boolean;
  listenError: string | null;
  client: { address: string; since: string } | null;
  faults: Record<PrinterFault, boolean>;
  /** Derived: executes commands only when online. */
  online: boolean;
  /** Bytes received but not yet executed (printer offline or command incomplete). */
  pendingBytes: number;
  asbEnabled: boolean;
  drawerOpen: boolean;
}

export type Support = 'supported' | 'ignored' | 'unsupported' | 'unknown';

export interface InspectorEntry {
  seq: number;
  at: string;
  kind: 'rx' | 'tx' | 'command' | 'info';
  /** Command name or a short human message. */
  label: string;
  hex: string;
  support?: Support;
  /** Full decoded message (the payment terminal's JSON, decrypted). */
  body?: string;
}

export interface PrinterSnapshot {
  config: PrinterConfig;
  status: PrinterStatus;
  /** Paper currently in the printer (printed but not cut yet). */
  paper: TicketInfo | null;
  tickets: TicketInfo[];
  inspector: InspectorEntry[];
}

export interface LabSnapshot {
  seq: number;
  printers: PrinterSnapshot[];
  terminals: TerminalSnapshot[];
  scanners: ScannerSnapshot[];
}

export type PrinterEvent =
  | { type: 'printer.config'; config: PrinterConfig }
  | { type: 'printer.status'; status: PrinterStatus }
  | { type: 'printer.paper'; paper: TicketInfo | null }
  | { type: 'printer.ticket'; ticket: TicketInfo }
  | { type: 'printer.tickets-deleted'; ids: string[] }
  | { type: 'printer.inspector'; entries: InspectorEntry[] };

export type LabEvent = (PrinterEvent | TerminalEvent | ScannerEvent) & { seq: number; deviceId: string };

/** Messages pushed on the WebSocket. The first one is always a snapshot. */
export type ServerMessage = { type: 'snapshot'; snapshot: LabSnapshot } | { type: 'event'; event: LabEvent };

export interface PrinterConfigPatch {
  name?: string;
  enabled?: boolean;
  port?: number;
  paperWidth?: PaperWidth;
}

// ---- payment terminal (Adyen Terminal API, nexo, local integration) ----

/** Shared key for message encryption, as configured for the terminal in the Adyen Customer Area. */
export interface SharedKey {
  keyIdentifier: string;
  passphrase: string;
  keyVersion: number;
}

export interface TerminalConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** HTTPS port of the Terminal API (8443 on a real terminal). */
  port: number;
  /** `<model>-<serial>`, e.g. V400m-324688179. It is also the certificate's common name. */
  poiid: string;
  /** Null: plain JSON (allowed only on test). */
  sharedKey: SharedKey | null;
  /** POS endpoint for display notifications (the Customer Area's "Local" event URL); null: none sent. */
  notificationUrl: string | null;
}

export type TerminalConfigPatch = Partial<Omit<TerminalConfig, 'id'>>;

export type EntryMode = 'Contactless' | 'ICC' | 'MagStripe';

/** Adyen POS test cards (docs.adyen.com/point-of-sale/testing-pos-payments). PIN 1234. */
export const TEST_CARDS = [
  { id: 'visa', label: 'Visa · test card v3', brand: 'visa', pan: '4111110002500002', expiry: '1230', funding: 'CREDIT', aid: 'A0000000031010', entry: ['Contactless', 'ICC'] },
  { id: 'maestro', label: 'Maestro · test card v2', brand: 'maestro', pan: '6000070736169237003', expiry: '0330', funding: 'DEBIT', aid: 'A0000000043060', entry: ['Contactless', 'ICC'] },
  { id: 'mc', label: 'Mastercard · test card v2', brand: 'mc', pan: '5413330089099999', expiry: '0228', funding: 'CREDIT', aid: 'A0000000041010', entry: ['Contactless', 'ICC'] },
  { id: 'visa-msr', label: 'Visa magnetic stripe', brand: 'visa', pan: '4151500000000008', expiry: '0330', funding: 'CREDIT', aid: '', entry: ['MagStripe'] },
] as const satisfies readonly { id: string; label: string; brand: string; pan: string; expiry: string; funding: string; aid: string; entry: readonly EntryMode[] }[];
export type TestCardId = (typeof TEST_CARDS)[number]['id'];

/**
 * Issuer outcomes of Adyen's test environment, chosen by the last three digits of the amount
 * (any other ending is approved). The panel can force one of them instead.
 */
export const ISSUER_OUTCOMES = {
  '121': ['Refusal', '214 Declined online', 'CANCELLED'],
  '122': ['Refusal', '124 acquirer fraud', 'ACQUIRER_FRAUD'],
  '123': ['Refusal', '214 Declined online', 'DECLINED'],
  '124': ['Refusal', '210 Not enough balance', 'NOT_ENOUGH_BALANCE'],
  '125': ['Refusal', '199 Card blocked', 'BLOCK_CARD'],
  '126': ['Refusal', '228 Card expired', 'CARD_EXPIRED'],
  '127': ['Refusal', '214 Declined online', 'INVALID_AMOUNT'],
  '128': ['InvalidCard', '214 Declined online', 'INVALID_CARD'],
  '129': ['Refusal', '214 Declined online', 'NOT_SUPPORTED'],
  '130': ['Refusal', '214 Declined online', 'ERROR'],
  '133': ['Refusal', '214 Declined online', 'REFERRAL'],
  '134': ['WrongPIN', '129 Invalid online PIN', 'INVALID_PIN'],
  '135': ['Refusal', '128 Online PIN tries exceeded', 'PIN_TRIES_EXCEEDED'],
  '136': ['Refusal', '207 Issuer unavailable', 'ISSUER UNAVAILABLE'],
  '137': ['Refusal', '211 Withdrawal amount exceeded', 'WITHDRAWAL_AMOUNT_EXCEEDED'],
  '138': ['Refusal', '212 Withdrawal count exceeded', 'WITHDRAWAL_COUNT_EXCEEDED'],
  '139': ['Refusal', '210 Not enough balance', 'NOT_ENOUGH_BALANCE'],
  '144': ['Refusal', '214 Declined online', 'NOT_SUBMITTED'],
  '146': ['Refusal', '214 Declined online', 'TRANSACTION_NOT_PERMITTED'],
  '147': ['Refusal', '214 Declined online', 'CVC_DECLINED'],
  '148': ['Refusal', '214 Declined online', 'RESTRICTED_CARD'],
  '151': ['Refusal', '214 Declined online', 'ISSUER_SUSPECTED_FRAUD'],
  '154': ['Cancel', '219 Shopper cancelled ctls fallback', '219 Shopper cancelled ctls fallback'],
  '158': ['Refusal', '235 AID banned', 'BAN_CURRENT_AID'],
  '162': ['Refusal', '214 Declined online', 'SECURITY_VIOLATION'],
  '166': ['Cancel', '102 Shopper cancelled pin entry', 'Shopper cancelled pin entry'],
} as const;
export type IssuerOutcomeCode = keyof typeof ISSUER_OUTCOMES;

/** How the lab drives the terminal: who plays the shopper and what the issuer answers. */
export interface TerminalBehaviour {
  /** manual: the shopper acts in the panel; auto: a test card is tapped and the PIN typed on its own. */
  shopper: 'manual' | 'auto';
  /** 'amount': Adyen's test rules by the amount's last digits; 'approve'; 'timeout' (no answer); or a forced outcome. */
  issuer: 'amount' | 'approve' | 'timeout' | IssuerOutcomeCode;
  /** The terminal finishes the payment but the HTTP response never reaches the POS. */
  responseLost: boolean;
}

export type TerminalPhase = 'idle' | 'card' | 'reading' | 'pin' | 'authorizing' | 'result';

/** What the terminal's screen shows. */
export interface TerminalScreen {
  phase: TerminalPhase;
  operation: 'payment' | 'refund' | null;
  amount: { value: number; currency: string } | null;
  /** Main line, as the terminal shows it. */
  message: string;
  pinDigits: number;
  result: 'approved' | 'declined' | 'cancelled' | null;
}

export interface TerminalStatus {
  listening: boolean;
  listenError: string | null;
  screen: TerminalScreen;
  behaviour: TerminalBehaviour;
  /** The card of the transaction in progress and how it was presented. */
  presented: { card: TestCardId; entry: EntryMode } | null;
  /** A chip card left in the reader. */
  cardInserted: TestCardId | null;
}

/** One payment, refund or reversal as the terminal recorded it. */
export interface TerminalTransaction {
  kind: 'payment' | 'refund' | 'reversal';
  /** POITransactionID.TransactionID */
  id: string;
  saleId: string;
  serviceId: string;
  at: string;
  amount: number;
  currency: string;
  result: 'Success' | 'Failure';
  errorCondition: string | null;
  detail: string;
  card: { brand: string; maskedPan: string; entry: EntryMode } | null;
  /** False when the response was lost on the way to the POS. */
  delivered: boolean;
}

export interface TerminalSnapshot {
  config: TerminalConfig;
  status: TerminalStatus;
  transactions: TerminalTransaction[];
  inspector: InspectorEntry[];
}

export type TerminalEvent =
  | { type: 'terminal.config'; config: TerminalConfig }
  | { type: 'terminal.status'; status: TerminalStatus }
  | { type: 'terminal.transaction'; transaction: TerminalTransaction }
  | { type: 'terminal.inspector'; entries: InspectorEntry[] };

// ---- barcode scanner (USB HID keyboard wedge, delivered as real key events through the POS's DevTools port) ----

export interface ScannerConfig {
  id: string;
  name: string;
  /** Unplugged: the trigger does nothing. */
  enabled: boolean;
  /** Where the POS (Electron started with --remote-debugging-port) listens. From Docker: host.docker.internal. */
  cdpHost: string;
  cdpPort: number;
  /** Text in the window's title or URL to type into; empty: the first window. */
  target: string;
  /** Key sent after the data, as programmed in a real scanner. */
  suffix: 'Enter' | 'Tab' | 'none';
  /** Milliseconds between keystrokes (real HID scanners: a few ms). */
  keyDelay: number;
}

export type ScannerConfigPatch = Partial<Omit<ScannerConfig, 'id'>>;

export type Symbology = 'EAN-13' | 'EAN-8' | 'UPC-A' | 'Code 128' | 'QR';

/** Products on the bench and test codes, with valid check digits. */
export const TEST_BARCODES = [
  { id: 'water', label: 'Mineral water 50 cl', symbology: 'EAN-13', data: '8412345678905' },
  { id: 'chocolate', label: 'Chocolate bar', symbology: 'EAN-8', data: '96385074' },
  { id: 'cereal', label: 'Cereal box', symbology: 'UPC-A', data: '036000291452' },
  { id: 'sku', label: 'Internal label (Code 128)', symbology: 'Code 128', data: 'POS-SKU-00042' },
  { id: 'coupon', label: 'QR coupon', symbology: 'QR', data: 'POSANDBOX:CUPON:XMAS-25' },
] as const satisfies readonly { id: string; label: string; symbology: Symbology; data: string }[];
export type TestBarcodeId = (typeof TEST_BARCODES)[number]['id'];

export interface ScanResult {
  seq: number;
  at: string;
  data: string;
  /** Delivered as key events to a POS window. */
  delivered: boolean;
  detail: string;
}

export interface ScannerStatus {
  /** Last check of the link to the POS window. */
  link: { ok: boolean; detail: string } | null;
  /** The code being typed right now (the beam is on). */
  scanning: string | null;
}

export interface ScannerSnapshot {
  config: ScannerConfig;
  status: ScannerStatus;
  scans: ScanResult[];
}

export type ScannerEvent =
  | { type: 'scanner.config'; config: ScannerConfig }
  | { type: 'scanner.status'; status: ScannerStatus }
  | { type: 'scanner.scan'; scan: ScanResult };
