#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ISSUER_OUTCOMES, PRINTER_FAULTS, TEST_CARDS, type LabSnapshot, type PrinterFault } from '../shared/contract.ts';
import { decodeStatus, PrinterClient, textTicket } from './printer.ts';
import { describe, header, send, serviceId, terminalTarget } from './terminal.ts';

// posandbox — talk to the lab's devices through their real interfaces (like a POS would),
// plus a few lab controls through the control API. One command group per device.

const HELP = `Usage: posandbox <device> <command> [options]

Printer (ESC/POS over TCP, like a real POS):
  posandbox printer status                status (DLE EOT 1-4) and identification (GS I)
  posandbox printer text "line" [...]      print text (PC858: € and accents) [--cut]
  posandbox printer sample                sample receipt (logo, table, barcode, QR)
  posandbox printer send <file|->      send raw ESC/POS bytes
  posandbox printer hex "1b 40 0a"        send hex bytes and show the response
  posandbox printer cut | feed [n] | drawer
  posandbox printer watch                 enable ASB and show each status change (Ctrl+C)

Payment terminal (Adyen Terminal API over HTTPS, like a real POS):
  posandbox terminal pay <amount> [--currency EUR]   pay and wait for the result
  posandbox terminal refund <amount>      unreferenced refund: the shopper presents a card
  posandbox terminal reverse <POITransactionID> [amount]   referenced reversal (ReversalRequest)
  posandbox terminal status <ServiceID>   transaction status (TransactionStatusRequest)
  posandbox terminal abort <ServiceID>    cancel an active transaction (AbortRequest)
  posandbox terminal ping                 DiagnosisRequest

Lab (control API; not used by the POS):
  posandbox lab status
  posandbox lab fault <${PRINTER_FAULTS.join('|')}> <on|off>
  posandbox lab drawer <open|close>         open with key or close the drawer by hand
  posandbox lab terminal present <${TEST_CARDS.map((c) => c.id).join('|')}> [contactless|chip|swipe]
  posandbox lab terminal pin <digits>      enter PIN and press OK
  posandbox lab terminal cancel | remove-card
  posandbox lab terminal shopper <manual|auto>
  posandbox lab terminal issuer <amount|approve|121…166>
  posandbox lab terminal lose-response <on|off>
  posandbox lab scanner scan <code>       pull the trigger: type the code into the POS window
  posandbox lab scanner probe               find the POS window through its DevTools port

Options:
  --host <h>      printer (default 127.0.0.1 or $POSANDBOX_PRINTER_HOST)
  --port <p>      TCP port (9100 or $POSANDBOX_PRINTER_PORT)
  --lab <url>     panel/API (http://127.0.0.1:8100 or $POSANDBOX_URL)
  --printer <id>  lab printer (front)
  --terminal <id> lab payment terminal (counter)
  --terminal-host <h> / --terminal-port <p>   payment terminal (127.0.0.1 and its configured port)
  --timeout <ms>  response timeout (1500)`;

type Out = (line: string) => void;
const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const SAMPLE = new URL('../../fixtures/sample-ticket.bin', import.meta.url);

export async function run(argv: string[], out: Out = console.log): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        host: { type: 'string', default: process.env.POSANDBOX_PRINTER_HOST ?? '127.0.0.1' },
        port: { type: 'string', default: process.env.POSANDBOX_PRINTER_PORT ?? '9100' },
        lab: { type: 'string', default: process.env.POSANDBOX_URL ?? 'http://127.0.0.1:8100' },
        printer: { type: 'string', default: 'front' },
        terminal: { type: 'string', default: 'counter' },
        'terminal-host': { type: 'string', default: process.env.POSANDBOX_TERMINAL_HOST ?? '127.0.0.1' },
        'terminal-port': { type: 'string', default: process.env.POSANDBOX_TERMINAL_PORT },
        currency: { type: 'string', default: 'EUR' },
        timeout: { type: 'string', default: '1500' },
        cut: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    out(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: o, positionals: [device, command, ...rest] } = parsed;
  const timeout = Number(o.timeout);
  try {
    if (device === 'printer' && command) return await printer(command, rest, { host: o.host, port: Number(o.port), timeout, cut: o.cut }, out);
    if (device === 'lab' && command) return await lab(command, rest, { url: o.lab, printer: o.printer, terminal: o.terminal }, out);
    if (device === 'terminal' && command) {
      const target = await terminalTarget(o.lab, o.terminal, o['terminal-host'], o['terminal-port'] ? Number(o['terminal-port']) : null);
      return await terminal(command, rest, target, o.currency, out);
    }
  } catch (error) {
    out(`Error: ${(error as Error).message}`);
    return 1;
  }
  out(HELP);
  return o.help ? 0 : 2;
}

async function printer(command: string, args: string[], o: { host: string; port: number; timeout: number; cut: boolean }, out: Out): Promise<number> {
  const client = await PrinterClient.open(o.host, o.port, o.timeout);
  try {
    switch (command) {
      case 'status': {
        out(`Printer ${o.host}:${o.port}`);
        const problems: string[] = [];
        for (const n of [1, 2, 3, 4]) {
          await client.write(PrinterClient.DLE_EOT(n));
          const [byte] = await client.read(1, o.timeout);
          if (byte === undefined) throw new Error(`no response to DLE EOT ${n}`);
          const meaning = decodeStatus(n, byte);
          problems.push(...meaning);
          out(`  DLE EOT ${n} → ${hex([byte])}  ${meaning.join(', ') || 'ok'}`);
        }
        await client.write(Uint8Array.from([...PrinterClient.GS_I(66), ...PrinterClient.GS_I(67)]));
        const maker = await client.readInfo(o.timeout);
        const model = maker && (await client.readInfo(o.timeout));
        out(`  Model: ${maker ? `${maker} ${model ?? ''}`.trim() : 'no response (normal commands wait while offline)'}`);
        out(problems.length ? `Status: ${[...new Set(problems)].join(', ')}` : 'Status: online, no issues');
        return 0;
      }
      case 'text':
        if (!args.length) throw new Error('provide at least one line of text');
        await client.write(textTicket(args, o.cut));
        out(`Sent ${args.length} lines${o.cut ? ' and cut' : ''}`);
        return 0;
      case 'sample':
        await client.write(new Uint8Array(readFileSync(SAMPLE)));
        out('Sample receipt sent');
        return 0;
      case 'send': {
        const file = args[0];
        if (!file) throw new Error('provide a file or - for standard input');
        const bytes = new Uint8Array(file === '-' ? readFileSync(0) : readFileSync(file));
        await client.write(bytes);
        out(`Sent ${bytes.length} bytes`);
        return 0;
      }
      case 'hex': {
        const digits = args.join(' ').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
        if (!digits || digits.length % 2) throw new Error('invalid hex: use pairs such as "10 04 01"');
        const bytes = Uint8Array.from(digits.match(/../g)!.map((h) => parseInt(h, 16)));
        await client.write(bytes);
        out(`→ ${hex([...bytes])}`);
        const reply = await client.read(Number.MAX_SAFE_INTEGER, Math.min(o.timeout, 400));
        out(reply.length ? `← ${hex(reply)}` : '← (no response)');
        return 0;
      }
      case 'cut':
        await client.write(Uint8Array.of(0x1b, 0x64, 4, 0x1d, 0x56, 1));
        out('Cut sent');
        return 0;
      case 'feed': {
        const lines = Math.max(1, Math.min(255, Number(args[0] ?? 3)));
        await client.write(Uint8Array.of(0x1b, 0x64, lines));
        out(`Fed ${lines} lines`);
        return 0;
      }
      case 'drawer':
        await client.write(Uint8Array.of(0x1b, 0x70, 0, 25, 250));
        out('Drawer pulse sent (ESC p)');
        return 0;
      case 'watch': {
        await client.write(Uint8Array.of(0x1d, 0x61, 0xff));
        out('ASB enabled. Waiting for changes (Ctrl+C to exit)…');
        for (;;) {
          const asb = await client.read(4, 3_600_000);
          if (asb.length < 4) continue;
          const flags = [
            asb[0] & 0x08 && 'offline', asb[0] & 0x20 && 'cover open', asb[0] & 0x40 && 'FEED',
            asb[1] & 0x40 && 'automatically recoverable error', asb[1] & 0x08 && 'cutter error',
            (asb[2] & 0x0c) === 0x0c && 'paper out', (asb[2] & 0x0c) !== 0x0c && (asb[2] & 0x03) === 0x03 && 'paper near end',
          ].filter(Boolean);
          out(`${new Date().toLocaleTimeString()}  ASB ${hex(asb)}  ${flags.join(', ') || 'online, no issues'}`);
        }
      }
      default:
        throw new Error(`unknown printer command: ${command}`);
    }
  } finally {
    await client.close();
  }
}

async function terminal(command: string, args: string[], t: Awaited<ReturnType<typeof terminalTarget>>, currency: string, out: Out): Promise<number> {
  const [arg] = args;
  switch (command) {
    case 'pay':
    case 'refund': {
      const amount = Number(arg?.replace(',', '.'));
      if (!(amount > 0)) throw new Error(`usage: posandbox terminal ${command} <amount> [--currency EUR]`);
      const service = serviceId();
      out(`PaymentRequest${command === 'refund' ? ' (Refund)' : ''} ${amount.toFixed(2)} ${currency} · ServiceID ${service} → ${t.poiid} (${t.host}:${t.port}${t.key ? ', encrypted' : ''})`);
      const message = {
        MessageHeader: header(t, 'Payment', service),
        PaymentRequest: {
          SaleData: { SaleTransactionID: { TransactionID: `cli-${service}`, TimeStamp: new Date().toISOString() } },
          PaymentTransaction: { AmountsReq: { Currency: currency, RequestedAmount: amount } },
          ...(command === 'refund' ? { PaymentData: { PaymentType: 'Refund' } } : {}),
        },
      };
      // Adyen: a payment can take 120 s on the terminal; the POS waits longer
      const { message: response } = await send(t, message, 150_000);
      for (const line of describe(response?.PaymentResponse ?? {})) out(`  ${line}`);
      return response?.PaymentResponse?.Response?.Result === 'Success' ? 0 : 1;
    }
    case 'reverse': {
      if (!arg) throw new Error('usage: posandbox terminal reverse <POITransactionID> [amount]');
      const amount = args[1] ? Number(args[1].replace(',', '.')) : undefined;
      const service = serviceId();
      const message = {
        MessageHeader: header(t, 'Reversal', service),
        ReversalRequest: {
          OriginalPOITransaction: { POITransactionID: { TransactionID: arg, TimeStamp: new Date().toISOString() } },
          ReversalReason: 'MerchantCancel',
          ...(amount ? { ReversedAmount: amount, SaleData: { SaleToAcquirerData: `currency=${currency}`, SaleTransactionID: { TransactionID: `cli-${service}`, TimeStamp: new Date().toISOString() } } } : {}),
        },
      };
      out(`ReversalRequest ${amount ? `${amount.toFixed(2)} ${currency}` : 'total'} of ${arg} · ServiceID ${service}`);
      const response = (await send(t, message, 30_000)).message?.ReversalResponse ?? {};
      for (const line of describe(response)) out(`  ${line}`);
      return response.Response?.Result === 'Success' ? 0 : 1;
    }
    case 'status': {
      if (!arg) throw new Error('usage: posandbox terminal status <ServiceID>');
      const message = { MessageHeader: header(t, 'TransactionStatus', serviceId()), TransactionStatusRequest: { MessageReference: { MessageCategory: 'Payment', SaleID: t.saleId, ServiceID: arg } } };
      const status = (await send(t, message, 10_000)).message?.TransactionStatusResponse ?? {};
      const original = status.RepeatedMessageResponse?.RepeatedResponseMessageBody?.PaymentResponse;
      out(original ? `Found (ServiceID ${arg}):` : describe(status)[0]);
      if (original) for (const line of describe(original)) out(`  ${line}`);
      return 0;
    }
    case 'abort': {
      if (!arg) throw new Error('usage: posandbox terminal abort <ServiceID>');
      const message = { MessageHeader: header(t, 'Abort', serviceId()), AbortRequest: { AbortReason: 'MerchantAbort', MessageReference: { MessageCategory: 'Payment', SaleID: t.saleId, ServiceID: arg } } };
      const { status } = await send(t, message, 10_000);
      out(`AbortRequest sent: HTTP ${status}`);
      return 0;
    }
    case 'ping': {
      const response = (await send(t, { MessageHeader: header(t, 'Diagnosis', serviceId()), DiagnosisRequest: { HostDiagnosisFlag: false } }, 10_000)).message?.DiagnosisResponse;
      out(`${t.poiid}: ${response?.POIStatus?.GlobalStatus ?? '?'} · ${describe(response ?? {})[0]}`);
      return 0;
    }
    default:
      throw new Error(`unknown terminal command: ${command}`);
  }
}

async function lab(command: string, args: string[], o: { url: string; printer: string; terminal: string }, out: Out): Promise<number> {
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${o.url}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {
      throw new Error(`Cannot connect to the lab at ${o.url}`);
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data;
  };
  switch (command) {
    case 'status': {
      const snapshot = (await api('GET', '/api/snapshot')) as LabSnapshot;
      for (const p of snapshot.printers) {
        const active = PRINTER_FAULTS.filter((f) => p.status.faults[f]);
        out(`${p.config.id}  ${p.config.name}  tcp:${p.config.port}  ${p.status.listening ? (p.status.online ? 'ready' : 'offline') : 'off'}` +
          `  client: ${p.status.client?.address ?? '—'}  drawer: ${p.status.drawerOpen ? 'open' : 'closed'}  faults: ${active.join(', ') || 'none'}  tickets: ${p.tickets.length}`);
      }
      return 0;
    }
    case 'fault': {
      const [fault, state] = args;
      if (!PRINTER_FAULTS.includes(fault as PrinterFault) || !['on', 'off'].includes(state)) {
        throw new Error(`usage: posandbox lab fault <${PRINTER_FAULTS.join('|')}> <on|off>`);
      }
      await api('PUT', `/api/printers/${encodeURIComponent(o.printer)}/faults`, { [fault]: state === 'on' });
      out(`${fault}: ${state}`);
      return 0;
    }
    case 'drawer': {
      const [state] = args;
      if (!['open', 'close'].includes(state)) throw new Error('usage: posandbox lab drawer <open|close>');
      await api('PUT', `/api/printers/${encodeURIComponent(o.printer)}/drawer`, { open: state === 'open' });
      out(`drawer: ${state === 'open' ? 'open' : 'closed'}`);
      return 0;
    }
    case 'scanner': {
      const [action, value] = args;
      const path = '/api/scanners/hand';
      if (action === 'scan' && value) {
        const scan = (await api('POST', `${path}/scan`, { data: value })) as { delivered: boolean; detail: string };
        out(`${scan.delivered ? 'Scanned' : 'Not delivered'}: ${value} · ${scan.detail}`);
        return scan.delivered ? 0 : 1;
      }
      if (action === 'probe') {
        const link = (await api('POST', `${path}/probe`)) as { ok: boolean; detail: string };
        out(`${link.ok ? 'POS found' : 'No POS'}: ${link.detail}`);
        return link.ok ? 0 : 1;
      }
      throw new Error('usage: posandbox lab scanner <scan <code>|probe>');
    }
    case 'terminal': {
      const [action, value, entry] = args;
      const path = `/api/terminals/${encodeURIComponent(o.terminal)}`;
      const ENTRY: Record<string, string> = { contactless: 'Contactless', chip: 'ICC', swipe: 'MagStripe' };
      switch (action) {
        case 'present':
          await api('POST', `${path}/present`, { card: value, entry: ENTRY[entry ?? (value === 'visa-msr' ? 'swipe' : 'contactless')] });
          break;
        case 'pin':
          if (!/^\d{4,12}$/.test(value ?? '')) throw new Error('usage: posandbox lab terminal pin <digits>');
          for (const key of [...value, 'enter']) await api('POST', `${path}/key`, { key });
          break;
        case 'cancel':
          await api('POST', `${path}/key`, { key: 'cancel' });
          break;
        case 'remove-card':
          await api('POST', `${path}/remove-card`);
          break;
        case 'shopper':
          await api('PUT', `${path}/behaviour`, { shopper: value });
          break;
        case 'issuer':
          if (value !== 'amount' && value !== 'approve' && value !== 'timeout' && !(value in ISSUER_OUTCOMES)) throw new Error(`usage: posandbox lab terminal issuer <amount|approve|${Object.keys(ISSUER_OUTCOMES).join('|')}>`);
          await api('PUT', `${path}/behaviour`, { issuer: value });
          break;
        case 'lose-response':
          await api('PUT', `${path}/behaviour`, { responseLost: value === 'on' });
          break;
        default:
          throw new Error('usage: posandbox lab terminal <present|pin|cancel|remove-card|shopper|issuer|lose-response> …');
      }
      out(`terminal: ${[action, value, entry].filter(Boolean).join(' ')}`);
      return 0;
    }
    default:
      throw new Error(`unknown lab command: ${command}`);
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
