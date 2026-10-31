// Sign in with Google (OpenID Connect, authorization code flow + PKCE).
// We only ask Google for "openid profile": an account id and a display name.
// We never ask for, receive or store an email address.
import crypto from 'node:crypto';

const FETCH_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_S = 120;
const JWKS_REFRESH_MIN_MS = 60_000;

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export function createOidc({ issuer, clientId, clientSecret, redirectUri, now = Date.now }) {
  let meta = null;
  let keys = new Map();
  let keysFetchedAt = 0;

  async function discover() {
    if (meta) return meta;
    const m = await fetchJson(`${issuer}/.well-known/openid-configuration`);
    if (m.issuer !== issuer) throw new Error('issuer mismatch in discovery document');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof m[k] !== 'string') throw new Error(`discovery document has no ${k}`);
    }
    meta = m;
    return meta;
  }

  async function loadKeys() {
    const { jwks_uri } = await discover();
    const set = await fetchJson(jwks_uri);
    const next = new Map();
    for (const jwk of set.keys || []) {
      if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.use && jwk.use !== 'sig')) continue;
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {}
    }
    keys = next;
    keysFetchedAt = now();
  }

  async function keyFor(kid) {
    if (!keys.has(kid) && now() - keysFetchedAt >= JWKS_REFRESH_MIN_MS) await loadKeys();
    if (!keys.size) await loadKeys();
    return keys.get(kid);
  }

  async function authUrl({ state, nonce, verifier }) {
    const { authorization_endpoint } = await discover();
    const u = new URL(authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return u.toString();
  }

  // Check an ID token completely; returns its claims or throws.
  async function verifyIdToken(idToken, nonce) {
    if (typeof idToken !== 'string') throw new Error('no id_token');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('malformed id_token');
    const header = b64json(parts[0]);
    if (header.alg !== 'RS256') throw new Error('unexpected signing algorithm');
    const key = await keyFor(header.kid);
    if (!key) throw new Error('unknown signing key');
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url')
    );
    if (!ok) throw new Error('bad id_token signature');
    const c = b64json(parts[1]);
    const t = Math.floor(now() / 1000);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    // Google sometimes writes the issuer without https://.
    const issOk = c.iss === issuer || (issuer === 'https://accounts.google.com' && c.iss === 'accounts.google.com');
    if (!issOk) throw new Error('wrong issuer');
    if (!aud.includes(clientId)) throw new Error('token not meant for this app');
    if (aud.length > 1 && c.azp !== clientId) throw new Error('wrong authorized party');
    if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_S < t) throw new Error('token expired');
    if (typeof c.iat === 'number' && c.iat - CLOCK_SKEW_S > t) throw new Error('token from the future');
    if (!nonce || c.nonce !== nonce) throw new Error('nonce mismatch');
    if (typeof c.sub !== 'string' || !c.sub) throw new Error('no account id');
    return c;
  }

  // Swap the one-time code for tokens and return { subject, name }.
  async function finish({ code, verifier, nonce }) {
    if (typeof code !== 'string' || !code || code.length > 2048) throw new Error('missing code');
    const { token_endpoint } = await discover();
    const res = await fetch(token_endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const body = await res.json();
    const claims = await verifyIdToken(body.id_token, nonce);
    // Access/refresh tokens are dropped here: we never call Google again.
    return { subject: claims.sub, name: claims.given_name || claims.name || '' };
  }

  return { authUrl, finish, verifyIdToken };
}
