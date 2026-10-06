import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal X.509 issuer (DER by hand, signed with node:crypto): a POSandbox root CA and, per terminal, a leaf
// whose common name has the shape the Adyen libraries check (`<POIID>.test.terminal.adyen.com`).
// No openssl binary and no dependency: the image stays as it is.

const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const int = (b: Buffer) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.of(0), b]) : b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.of(unused), b);
const octets = (b: Buffer) => tlv(0x04, b);
const TRUE = tlv(0x01, Buffer.of(0xff));

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime (valid until 2049, which covers every date issued here). */
const time = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

const name = (cn: string) =>
  seq(
    set(seq(oid('2.5.4.10'), tlv(0x0c, Buffer.from('POSandbox')))),
    set(seq(oid('2.5.4.11'), tlv(0x0c, Buffer.from('POSandbox CA')))),
    set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))),
  );

const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0)));
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [TRUE] : []), octets(value));
/** Key identifier: SHA-1 of the whole SubjectPublicKeyInfo (RFC 5280 §4.2.1.2 allows any unique value). */
const keyId = (key: KeyObject) => createHash('sha1').update(key.export({ type: 'spki', format: 'der' })).digest();

interface Issued {
  certPem: string;
  keyPem: string;
}

function issue(subject: string, publicKey: KeyObject, signer: KeyObject, issuer: { cn: string; publicKey: KeyObject } | null, years: number, leaf: { dns: string[]; ips: string[] } | null): string {
  const now = Date.now();
  const serial = randomBytes(16);
  // positive and minimal DER: a leading 0x00 byte is "illegal padding" to OpenSSL
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const caKeyId = keyId(issuer?.publicKey ?? publicKey);
  const extensions = leaf
    ? [
        extension('2.5.29.19', true, seq()),
        extension('2.5.29.15', true, bits(Buffer.of(0xa0), 5)), // digitalSignature, keyEncipherment
        extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // serverAuth
        extension('2.5.29.17', false, seq(...leaf.dns.map((d) => tlv(0x82, Buffer.from(d))), ...leaf.ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))))),
        extension('2.5.29.14', false, octets(keyId(publicKey))),
        extension('2.5.29.35', false, seq(tlv(0x80, caKeyId))),
      ]
    : [
        extension('2.5.29.19', true, seq(TRUE)),
        extension('2.5.29.15', true, bits(Buffer.of(0x06), 1)), // keyCertSign, cRLSign
        extension('2.5.29.14', false, octets(caKeyId)),
      ];
  const tbs = seq(
    tlv(0xa0, int(Buffer.of(2))),
    int(serial),
    SHA256_RSA,
    name(issuer?.cn ?? subject),
    seq(time(new Date(now - 86_400_000)), time(new Date(now + years * 365 * 86_400_000))),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...extensions)),
  );
  const der = seq(tbs, SHA256_RSA, bits(sign('sha256', tbs, signer)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{64}/g, '$&\n').trim()}\n-----END CERTIFICATE-----\n`;
}

const CA_CN = 'POSandbox Test Terminal Fleet Root';
const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });

export function createCa(): Issued {
  const { privateKey, publicKey } = pair();
  return { certPem: issue(CA_CN, publicKey, privateKey, null, 20, null), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

/** Leaf certificate for a terminal: CN `<POIID>.test.terminal.adyen.com`, as a real test terminal presents. */
export function createTerminalCert(ca: Issued, poiid: string): Issued {
  const { privateKey, publicKey } = pair();
  const cn = `${poiid}.test.terminal.adyen.com`;
  // 2-year leaf, regenerated on start when expired; libraries never compare the IP, so SAN is a courtesy
  const certPem = issue(cn, publicKey, createPrivateKey(ca.keyPem), { cn: CA_CN, publicKey: createPublicKey(ca.keyPem) }, 2, { dns: [cn, 'localhost'], ips: ['127.0.0.1'] });
  return { certPem: `${certPem}${ca.certPem}`, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

export interface TerminalPki {
  /** What the POS must trust (instead of, or next to, Adyen's root). */
  caPem: string;
  /** Leaf followed by the CA: the chain the terminal presents. */
  certPem: string;
  keyPem: string;
}

/** Loads `<dir>/ca.*` and `<dir>/<terminalId>.*`, creating whatever is missing, expired or issued for another POIID. */
export function loadPki(dir: string, terminalId: string, poiid: string): TerminalPki {
  mkdirSync(dir, { recursive: true });
  const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null);
  const save = (base: string, cert: string, issued: Issued) => {
    writeFileSync(join(dir, cert), issued.certPem);
    writeFileSync(join(dir, `${base}.key`), issued.keyPem, { mode: 0o600 });
    return issued;
  };
  const caCert = read('ca.pem');
  const caKey = read('ca.key');
  const ca = caCert && caKey && !expired(caCert) ? { certPem: caCert, keyPem: caKey } : save('ca', 'ca.pem', createCa());
  const cert = read(`${terminalId}.pem`);
  const key = read(`${terminalId}.key`);
  const valid = cert && key && !expired(cert) && cert.includes(ca.certPem) && new X509Certificate(cert).subject.includes(`CN=${poiid}.`);
  const leaf = valid ? { certPem: cert, keyPem: key } : save(terminalId, `${terminalId}.pem`, createTerminalCert(ca, poiid));
  return { caPem: ca.certPem, certPem: leaf.certPem, keyPem: leaf.keyPem };
}

const expired = (pem: string) => new Date(new X509Certificate(pem).validTo).getTime() < Date.now() + 86_400_000;
