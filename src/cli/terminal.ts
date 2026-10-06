import { randomInt } from 'node:crypto';
import { request } from 'node:https';
import type { LabSnapshot, SharedKey, TerminalSnapshot } from '../shared/contract.ts';
import { decrypt, encrypt, type Envelope } from '../server/terminal/nexo-crypto.ts';

// The CLI as a POS: Terminal API messages over HTTPS, like Adyen's libraries in a local integration.
// The terminal's POIID, shared key and the CA to trust come from the lab (a real POS has them in its config).

export interface TerminalTarget {
  host: string;
  port: number;
  ca: string;
  poiid: string;
  key: SharedKey | null;
  saleId: string;
}

/** POIID, key and CA of a lab terminal, read through the control API. */
export async function terminalTarget(lab: string, id: string, host: string, port: number | null): Promise<TerminalTarget> {
  const get = async (path: string) => {
    const res = await fetch(`${lab}${path}`).catch(() => {
      throw new Error(`Cannot connect to the lab at ${lab}`);
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} at ${path}`);
    return res;
  };
  const snapshot = (await (await get('/api/snapshot')).json()) as LabSnapshot;
  const terminal = snapshot.terminals.find((t: TerminalSnapshot) => t.config.id === id);
  if (!terminal) throw new Error(`no payment terminal “${id}” in the lab`);
  const ca = await (await get(`/api/terminals/${encodeURIComponent(id)}/ca.pem`)).text();
  return { host, port: port ?? terminal.config.port, ca, poiid: terminal.config.poiid, key: terminal.config.sharedKey, saleId: 'POSANDBOX-CLI' };
}

export const serviceId = () => String(randomInt(1, 2 ** 31));

export function header(t: TerminalTarget, category: string, service: string) {
  return { ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: category, MessageType: 'Request', SaleID: t.saleId, ServiceID: service, POIID: t.poiid };
}

/** POST /nexo/ and the decrypted SaleToPOIResponse (null for an empty body, as an abort returns). */
export function send(t: TerminalTarget, message: { MessageHeader: unknown; [body: string]: unknown }, timeoutMs: number): Promise<{ status: number; message: Record<string, any> | null }> {
  const body = JSON.stringify(t.key ? encrypt('SaleToPOIRequest', message, t.key) : { SaleToPOIRequest: message });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: t.host, port: t.port, path: '/nexo/', method: 'POST', ca: t.ca, timeout: timeoutMs,
        headers: { 'content-type': 'application/json' },
        // like the Adyen libraries: trust the given CA, check the common name pattern, never the host
        checkServerIdentity: (_host, cert) =>
          /^(([a-zA-Z0-9]+-[a-zA-Z0-9]+)|legacy-terminal-certificate)\.(live|test)\.terminal\.adyen\.com$/.test(String(cert.subject.CN)) ? undefined : new Error(`Unexpected CN: ${cert.subject.CN}`),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (c) => (text += c)).on('end', () => {
          if (!text) return resolve({ status: res.statusCode!, message: null });
          let json = JSON.parse(text);
          if (json.SaleToPOIResponse?.NexoBlob) {
            const plain = t.key && decrypt(json.SaleToPOIResponse as Envelope, t.key);
            if (!plain) return reject(new Error('encrypted response cannot be decrypted with the configured key'));
            json = JSON.parse(plain);
          }
          resolve({ status: res.statusCode!, message: json.SaleToPOIResponse ?? json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no response within ${timeoutMs / 1000} s`)));
    req.on('error', (e) => reject(e.message.includes('socket hang up') ? new Error('the terminal closed the connection without responding (response lost?)') : e));
    req.end(body);
  });
}

/** One line per result: what a cashier would need to know. */
export function describe(response: Record<string, any>): string[] {
  const r = response.Response ?? {};
  const extra = Object.fromEntries(new URLSearchParams(r.AdditionalResponse ?? ''));
  const lines = [`Result: ${r.Result}${r.ErrorCondition ? ` / ${r.ErrorCondition}` : ''}${extra.refusalReason ? ` (${extra.refusalReason})` : ''}${extra.message && !extra.refusalReason ? ` (${extra.message})` : ''}`];
  const id = response.POIData?.POITransactionID?.TransactionID;
  if (id) lines.push(`POITransactionID: ${id}`);
  const card = response.PaymentResult?.PaymentInstrumentData?.CardData;
  if (card?.MaskedPan) lines.push(`Card: ${card.PaymentBrand} ${card.MaskedPan} · ${card.EntryMode?.join(', ')}`);
  return lines;
}
