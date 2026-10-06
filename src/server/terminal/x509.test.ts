import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createCa, createTerminalCert } from './x509.ts';

const ca = createCa();
const leaf = createTerminalCert(ca, 'V400m-324688179');

test('the root is a CA and signs the terminal certificate', () => {
  const root = new X509Certificate(ca.certPem);
  const cert = new X509Certificate(leaf.certPem);
  assert.equal(root.ca, true);
  assert.equal(cert.ca, false);
  assert.ok(cert.checkIssued(root));
  assert.ok(cert.verify(root.publicKey));
  assert.match(cert.subject, /CN=V400m-324688179\.test\.terminal\.adyen\.com/);
});

test('the common name passes the checks of the Adyen Node, Java and .NET libraries', () => {
  const cn = new X509Certificate(leaf.certPem).subject.match(/CN=(.+)/)![1];
  assert.match(cn, /^(([a-zA-Z0-9]+-[a-zA-Z0-9]+)|legacy-terminal-certificate)\.(live|test)\.terminal\.adyen\.com$/); // Node
  assert.match(cn, /^[a-zA-Z0-9]{3,}-[a-zA-Z0-9]{9,15}\.test\.terminal\.adyen\.com$/); // Java
  assert.match(cn, /[a-zA-Z0-9]{3,}-[0-9]{9,15}\.test\.terminal\.adyen\.com/); // .NET
});

test('a TLS client that trusts only the POSandbox root completes the handshake', async () => {
  const server = createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        // like the Node library: its own CA file, CN pattern instead of a hostname check
        { host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/nexo', method: 'POST', ca: ca.certPem, minVersion: 'TLSv1.2',
          checkServerIdentity: (_host, cert) => (/\.test\.terminal\.adyen\.com$/.test(String(cert.subject.CN)) ? undefined : new Error('bad CN')) },
        (res) => res.setEncoding('utf8').on('data', resolve),
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'ok');
  } finally {
    server.close();
  }
});
