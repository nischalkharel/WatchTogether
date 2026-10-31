// A stand-in for Google's sign-in servers, for tests. It speaks the same
// OpenID Connect protocol with real RSA-signed tokens, and can be told to
// misbehave (bad signature, wrong audience, ...) to test that we refuse.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startFakeGoogle({ clientId, clientSecret, port = 0 }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const codes = new Map(); // code -> { sub, name, nonce, challenge, redirectUri }
  const fake = {
    nextUser: { sub: 'google-user-1', name: 'Alex Example', email: 'alex@example.com' },
    tamper: null, // 'signature' | 'audience' | 'expired' | 'nonce' | 'issuer' | 'alg-none' | 'unknown-kid'
    tokenRequests: [],
    authRequests: [],
  };

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  function sign(claims) {
    const t = fake.tamper;
    if (t === 'alg-none') return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    const header = { alg: 'RS256', typ: 'JWT', kid: t === 'unknown-kid' ? 'nope' : kid };
    const data = `${b64(header)}.${b64(claims)}`;
    const key = t === 'signature' ? evil.privateKey : privateKey;
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, fake.issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: fake.issuer,
        authorization_endpoint: `${fake.issuer}/o/oauth2/v2/auth`,
        token_endpoint: `${fake.issuer}/token`,
        jwks_uri: `${fake.issuer}/certs`,
      });
    }
    if (url.pathname === '/certs') {
      return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
    }
    if (url.pathname === '/next-user' && req.method === 'POST') {
      // Test control: which Google account picks "sign in" next.
      let body = '';
      for await (const c of req) body += c;
      fake.nextUser = JSON.parse(body);
      return json(200, { ok: true });
    }
    if (url.pathname === '/o/oauth2/v2/auth') {
      // "The person picked their Google account": send them straight back.
      const p = url.searchParams;
      fake.authRequests.push(Object.fromEntries(p));
      if (p.get('client_id') !== clientId) return json(400, { error: 'invalid_client' });
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, {
        ...fake.nextUser,
        nonce: p.get('nonce'),
        challenge: p.get('code_challenge'),
        redirectUri: p.get('redirect_uri'),
      });
      const back = new URL(p.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      fake.tokenRequests.push(Object.fromEntries(p));
      const c = codes.get(p.get('code'));
      codes.delete(p.get('code')); // one use
      if (!c) return json(400, { error: 'invalid_grant' });
      if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
      if (p.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'redirect_uri_mismatch' });
      const verifier = p.get('code_verifier') || '';
      if (crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'PKCE failed' });
      }
      const t = Math.floor(Date.now() / 1000);
      const tm = fake.tamper;
      const claims = {
        iss: tm === 'issuer' ? 'https://evil.example' : fake.issuer,
        aud: tm === 'audience' ? 'someone-elses-app' : clientId,
        sub: c.sub,
        name: c.name,
        given_name: c.name.split(' ')[0],
        email: c.email, // Google would only send this with the email scope; we must ignore it anyway
        nonce: tm === 'nonce' ? 'wrong-nonce' : c.nonce,
        iat: t,
        exp: tm === 'expired' ? t - 3600 : t + 3600,
      };
      return json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: sign(claims) });
    }
    json(404, { error: 'not found' });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  fake.issuer = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((r) => server.close(r));
  return fake;
}
