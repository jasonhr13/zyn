// SMS provider client — endpoints/auth ported from the user's own previously-working Python
// implementation (Fable-Generate/sms.py), NOT guessed. That file verified each provider's real
// request/response shape against live traffic; this is a trimmed Node port covering just
// purchase/fetchSms/cancel (drops the Walmart stock-catalog machinery, which doesn't apply here).
//
// IMPORTANT: these providers sell numbers per TARGET SERVICE (walmart, amazon, discord, ...).
// "P-Bandai" is very unlikely to be a listed service on any of them. purchase() will throw a real
// ConfigError from the provider if the service slug isn't recognized — that's not a bug, it means
// the chosen provider doesn't support this site. Check for a generic "any site" / "other" rental
// option, or pass a --smsService that matches what the provider actually lists.

export class StockEmptyError extends Error {}
export class OutOfBalanceError extends Error {}
export class AuthError extends Error {}
export class ConfigError extends Error {}

const DEFAULT_BASE_URLS = {
  getatext: 'https://getatext.com',
  textverified: 'https://www.textverified.com',
  grizzlysms: 'https://api.grizzlysms.com',
  smshub: 'https://smshub.org',
  '5sim': 'https://5sim.net',
  smspool: 'https://api.smspool.net',
};

function extractOtp(body) {
  if (!body) return null;
  const m = String(body).match(/(?<!\d)(\d{4,8})(?!\d)/);
  return m ? m[1] : null;
}

function digitsOnly(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d || null;
}

async function retryFetch(url, opts = {}, { idempotent = true, maxAttempts = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts - 1) throw e;
      await new Promise(r => setTimeout(r, Math.min(600 * 2 ** attempt, 8000)));
      continue;
    }
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      lastErr = new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
      if (!idempotent || attempt === maxAttempts - 1) return res; // don't retry a non-idempotent rent past attempt 1
      await new Promise(r => setTimeout(r, Math.min(600 * 2 ** attempt, 8000)));
      continue;
    }
    return res;
  }
  throw lastErr || new Error('request failed (no response)');
}

export class SmsClient {
  constructor(provider, apiKey, opts = {}) {
    this.provider = provider.toLowerCase();
    this.apiKey = apiKey;
    this.apiUsername = opts.apiUsername || ''; // TextVerified only
    this.apiBaseUrl = (opts.apiBaseUrl || DEFAULT_BASE_URLS[this.provider] || '').replace(/\/$/, '');
    // Optional (label, data) callback so the caller can surface raw API responses in ITS log —
    // added because a provider's real response shape can differ from any doc/reference, and
    // guessing again after a failed live run wastes real money on rented numbers.
    this.onDebug = typeof opts.onDebug === 'function' ? opts.onDebug : () => {};
  }

  _url(path) { return path.startsWith('http') ? path : this.apiBaseUrl + (path.startsWith('/') ? path : '/' + path); }

  async purchase(service = 'pbandai', country = 'us') {
    switch (this.provider) {
      case 'getatext': return this._getatextPurchase(service);
      case 'textverified': return this._textverifiedPurchase(service);
      case 'grizzlysms':
      case 'smshub': return this._grizzlyPurchase(service);
      case '5sim': return this._fivesimPurchase(service);
      case 'smspool': return this._smspoolPurchase(service, country);
      default: throw new ConfigError(`Unsupported SMS provider: ${this.provider}`);
    }
  }

  async fetchSms(purchaseId) {
    switch (this.provider) {
      case 'getatext': return this._getatextFetch(purchaseId);
      case 'textverified': return this._textverifiedFetch(purchaseId);
      case 'grizzlysms':
      case 'smshub': return this._grizzlyFetch(purchaseId);
      case '5sim': return this._fivesimFetch(purchaseId);
      case 'smspool': return this._smspoolFetch(purchaseId);
      default: throw new ConfigError(`Unsupported SMS provider: ${this.provider}`);
    }
  }

  async cancel(purchaseId) {
    try {
      switch (this.provider) {
        case 'getatext': return this._getatextCancel(purchaseId);
        case 'textverified': return this._textverifiedCancel(purchaseId);
        case 'grizzlysms':
        case 'smshub': return this._grizzlySetStatus(purchaseId, 8);
        case '5sim': return this._fivesimCancel(purchaseId);
        case 'smspool': return this._smspoolCancel(purchaseId);
        default: return false;
      }
    } catch { return false; }
  }

  // ── GetAText ── Auth header, JSON body, POST /api/v1/rent-a-number ─────────
  async _getatextPurchase(service) {
    const res = await retryFetch(this._url('/api/v1/rent-a-number'), {
      method: 'POST',
      headers: { Auth: this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: service.toLowerCase() }),
    }, { idempotent: false });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ConfigError(`GetAText rent failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    const phone = data.number || data.phone;
    const pid = data.id;
    if (!phone || pid == null) throw new ConfigError(`GetAText unexpected rent response: ${JSON.stringify(data)}`);
    return { phone: String(phone), purchaseId: String(pid), expiresAt: null };
  }
  async _getatextFetch(purchaseId) {
    const res = await fetch(this._url('/api/v1/rental-status'), {
      method: 'POST',
      headers: { Auth: this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(purchaseId) }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.code != null ? digitsOnly(data.code) : null;
  }
  async _getatextCancel(purchaseId) {
    const res = await fetch(this._url('/api/v1/cancel-rental'), {
      method: 'POST',
      headers: { Auth: this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(purchaseId) }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return data.status == null || ['cancelled', 'canceled'].includes(data.status);
  }

  // ── TextVerified v2 ── two-step auth (X-API-KEY/X-API-USERNAME -> Bearer), action-envelope rent ──
  async _textverifiedAuth() {
    if (!this.apiUsername) throw new AuthError('TextVerified needs BOTH an API key and your account username/email — set --smsApiUsername.');
    const res = await fetch(this._url('/api/pub/v2/auth'), {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'X-API-USERNAME': this.apiUsername },
    });
    if (!res.ok) throw new AuthError(`TextVerified auth failed: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const token = data.token || data.bearerToken;
    if (!token) throw new AuthError('TextVerified auth returned no token');
    return token;
  }
  async _textverifiedPurchase(service) {
    const token = await this._textverifiedAuth();
    const res = await retryFetch(this._url('/api/pub/v2/verifications'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceName: service, capability: 'sms', areaCodeSelectOption: [], carrierSelectOption: [] }),
    }, { idempotent: false });
    const env = await res.json().catch(() => ({}));
    if (!res.ok) throw new ConfigError(`TextVerified rent failed: HTTP ${res.status} ${JSON.stringify(env).slice(0, 200)}`);
    const action = (env.data && typeof env.data === 'object') ? env.data : env;
    const href = action.href || env.href;
    if (!href) throw new ConfigError(`TextVerified unexpected create-verification response: ${JSON.stringify(env)}`);
    const vRes = await fetch(this._url(href), { headers: { Authorization: `Bearer ${token}` } });
    const vEnv = await vRes.json().catch(() => ({}));
    const v = (vEnv.data && typeof vEnv.data === 'object') ? vEnv.data : vEnv;
    const phone = v.number || v.phoneNumber;
    const pid = v.id || v.verificationId;
    if (!phone || pid == null) throw new ConfigError(`TextVerified verification missing number/id: ${JSON.stringify(v)}`);
    this._tvPhoneById = this._tvPhoneById || {};
    this._tvPhoneById[String(pid)] = String(phone);
    return { phone: String(phone), purchaseId: String(pid), expiresAt: v.endsAt || null };
  }
  async _textverifiedFetch(purchaseId) {
    const token = await this._textverifiedAuth();
    let phone = (this._tvPhoneById || {})[String(purchaseId)];
    if (!phone) {
      const vRes = await fetch(this._url(`/api/pub/v2/verifications/${purchaseId}`), { headers: { Authorization: `Bearer ${token}` } });
      const vEnv = await vRes.json().catch(() => ({}));
      const v = (vEnv.data && typeof vEnv.data === 'object') ? vEnv.data : vEnv;
      phone = v.number || v.phoneNumber;
    }
    if (!phone) return null;
    const res = await fetch(this._url(`/api/pub/v2/sms?to=${encodeURIComponent(phone)}`), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const messages = data.data || data.messages || (Array.isArray(data) ? data : []);
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.parsedCode) { const d = digitsOnly(m.parsedCode); if (d) return d; }
      const code = extractOtp(m.smsContent || m.text || m.body);
      if (code) return code;
    }
    return null;
  }
  async _textverifiedCancel(purchaseId) {
    const token = await this._textverifiedAuth();
    const res = await fetch(this._url(`/api/pub/v2/verifications/${purchaseId}/cancel`), {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    return res.status === 200 || res.status === 204;
  }

  // ── GrizzlySMS / SMS-Activate protocol (also used by smshub) ───────────────
  async _grizzlyRequest(action, extra = {}, { idempotent = true } = {}) {
    const params = new URLSearchParams({ api_key: this.apiKey, action });
    for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') params.set(k, v);
    const res = await retryFetch(this._url(`/stubs/handler_api.php?${params}`), {}, { idempotent });
    return res.text();
  }
  static _splitText(text) {
    const s = (text || '').trim();
    if (!s) return { head: '', rest: [] };
    const parts = s.split(':');
    return { head: parts[0], rest: parts.slice(1) };
  }
  _grizzlyRaiseError(head, text) {
    const msg = (text || '').trim();
    if (head === 'NO_NUMBERS') throw new StockEmptyError(`no stock for this service/country`);
    if (['NO_BALANCE', 'NO_MONEY'].includes(head)) throw new OutOfBalanceError('out of balance');
    if (['BAD_KEY', 'NO_KEY', 'ERROR_WRONG_KEY', 'WRONG_TOKEN'].includes(head)) throw new AuthError(`auth failed (${head})`);
    if (head === 'BAD_SERVICE') throw new ConfigError(`BAD_SERVICE — this provider doesn't list this service`);
    if (head === 'BANNED') throw new AuthError('account banned');
    throw new ConfigError(`Grizzly/SMS-Activate error: ${head} ${msg}`.trim());
  }
  async _grizzlyPurchase(service) {
    const country = '12'; // USA-virtual by default — matches the reference implementation's default
    const text = await this._grizzlyRequest('getNumberV2', { service, country }, { idempotent: false });
    if (text.trim().startsWith('{')) {
      const data = JSON.parse(text);
      const { activationId, phoneNumber, activationEnd } = data;
      if (!activationId || !phoneNumber) throw new ConfigError(`getNumberV2 missing fields: ${text}`);
      return { phone: String(phoneNumber), purchaseId: String(activationId), expiresAt: activationEnd || null };
    }
    const { head, rest } = SmsClient._splitText(text);
    if (head === 'ACCESS_NUMBER' && rest.length >= 2) {
      return { phone: String(rest[1]), purchaseId: String(rest[0]), expiresAt: null };
    }
    this._grizzlyRaiseError(head, text);
  }
  async _grizzlyFetch(purchaseId) {
    const text = await this._grizzlyRequest('getStatus', { id: purchaseId });
    const { head, rest } = SmsClient._splitText(text);
    if (head === 'STATUS_OK' && rest.length) return digitsOnly(rest.join(':'));
    return null;
  }
  async _grizzlySetStatus(purchaseId, status) {
    const text = await this._grizzlyRequest('setStatus', { id: purchaseId, status });
    const { head } = SmsClient._splitText(text);
    return ['ACCESS_READY', 'ACCESS_RETRY_GET', 'ACCESS_ACTIVATION', 'ACCESS_CANCEL', 'STATUS_OK'].includes(head);
  }

  // ── 5sim ── Bearer JWT, path-based JSON REST ────────────────────────────────
  async _fivesimPurchase(service) {
    const res = await retryFetch(this._url(`/v1/user/buy/activation/usa/any/${service}`), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    }, { idempotent: false });
    const text = await res.text();
    this.onDebug('5sim purchase raw response', { status: res.status, body: text });
    // BUG FIX: an HTTP error with an EMPTY body (401/404/etc) was falling through to the generic
    // "unexpected response" branch with a blank message, giving zero clue what actually failed —
    // check status explicitly first so auth/not-found errors are labeled correctly.
    if (res.status === 401 || res.status === 403) throw new AuthError(`5sim auth failed: HTTP ${res.status} — check the API key (JWT)`);
    if (res.status === 404) throw new ConfigError(`5sim: HTTP 404 — "${service}" likely isn't a valid service slug on 5sim`);
    if (text.trim() === 'no free phones') throw new StockEmptyError(`5sim: no free phones for ${service}`);
    if (!res.ok) throw new ConfigError(`5sim: HTTP ${res.status}${text ? ` — ${text.slice(0, 160)}` : ' (empty body)'}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new ConfigError(`5sim unexpected response: HTTP ${res.status}${text ? ` — ${text.slice(0, 160)}` : ' (empty body)'}`); }
    if (!data.phone || data.id == null) throw new ConfigError(`5sim unexpected buy response: ${text}`);
    return { phone: String(data.phone), purchaseId: String(data.id), expiresAt: data.expires || null };
  }
  async _fivesimFetch(purchaseId) {
    const res = await fetch(this._url(`/v1/user/check/${purchaseId}`), { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const sms = Array.isArray(data.sms) ? data.sms : [];
    if (!sms.length) return null;
    const last = sms[sms.length - 1];
    if (last?.code) { const d = digitsOnly(last.code); if (d) return d; }
    return extractOtp(last?.text);
  }
  async _fivesimCancel(purchaseId) {
    const res = await fetch(this._url(`/v1/user/cancel/${purchaseId}`), { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return data.status == null || ['CANCELED', 'CANCELLED'].includes(data.status);
  }

  // ── SMSPool ── key= param auth, numeric country/service ids resolved via catalog ──
  async _smspoolResolveCountryId() {
    if (this._smspoolCountryId) return this._smspoolCountryId;
    const res = await fetch(this._url(`/country/retrieve_all?key=${encodeURIComponent(this.apiKey)}`));
    const rows = await res.json().catch(() => []);
    const hit = (rows || []).find(c => ['united states', 'usa', 'united states of america'].includes((c.name || '').toLowerCase().trim()));
    this._smspoolCountryId = hit ? String(hit.ID ?? hit.id) : '1';
    return this._smspoolCountryId;
  }
  async _smspoolResolveServiceId(service) {
    const country = await this._smspoolResolveCountryId();
    const res = await fetch(this._url(`/service/retrieve_all?key=${encodeURIComponent(this.apiKey)}&country=${country}`));
    const rows = await res.json().catch(() => []);
    const slug = service.toLowerCase().trim();
    const hit = (rows || []).find(s => (s.name || s.short_name || '').toLowerCase().trim() === slug)
      || (rows || []).find(s => (s.name || s.short_name || '').toLowerCase().includes(slug));
    if (!hit) throw new ConfigError(`SMSPool: "${service}" not found in the service catalog — this provider likely doesn't support this site.`);
    return String(hit.ID ?? hit.id);
  }
  async _smspoolPurchase(service) {
    const country = await this._smspoolResolveCountryId();
    const sid = await this._smspoolResolveServiceId(service);
    const body = new URLSearchParams({ key: this.apiKey, country, service: sid });
    const res = await retryFetch(this._url('/purchase/sms'), { method: 'POST', body }, { idempotent: false });
    const data = await res.json().catch(() => ({}));
    if (String(data.success) !== '1') {
      const msg = [data.type, data.message, ...(Array.isArray(data.errors) ? data.errors.map(e => e.message) : [])].filter(Boolean).join(' ');
      const low = msg.toLowerCase();
      if (low.includes('balance')) throw new OutOfBalanceError(msg || 'smspool out of balance');
      if (low.includes('stock') || low.includes('available')) throw new StockEmptyError(msg || 'smspool out of stock');
      throw new ConfigError(msg || `smspool purchase failed: ${JSON.stringify(data)}`);
    }
    const phone = data.number || (data.phonenumber ? String(data.phonenumber) : null);
    if (!phone || !data.order_id) throw new ConfigError(`smspool unexpected purchase response: ${JSON.stringify(data)}`);
    return { phone: String(phone), purchaseId: String(data.order_id), expiresAt: null };
  }
  async _smspoolFetch(purchaseId) {
    const res = await fetch(this._url(`/sms/check?key=${encodeURIComponent(this.apiKey)}&orderid=${encodeURIComponent(purchaseId)}`));
    if (!res.ok) {
      this.onDebug('smspool fetchSms HTTP error', { status: res.status, body: await res.text().catch(() => '') });
      return null;
    }
    const raw = await res.text();
    this.onDebug('smspool fetchSms raw response', raw);
    let data;
    try { data = JSON.parse(raw); } catch { return null; }
    // Prefer the documented status===3 gate, but also accept sms/full_sms being non-empty
    // regardless of status — if the real status semantics differ from the reference this was built
    // against, actual SMS text being present is the strongest signal the code has arrived.
    const hasCode = Number(data.status) === 3 || !!data.sms || !!data.full_sms;
    if (!hasCode) return null;
    if (data.sms) { const d = digitsOnly(data.sms); if (d) return d; }
    return extractOtp(data.full_sms);
  }
  async _smspoolCancel(purchaseId) {
    const res = await fetch(this._url(`/sms/cancel?key=${encodeURIComponent(this.apiKey)}&orderid=${encodeURIComponent(purchaseId)}`));
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return String(data.success) === '1';
  }
}

export async function createSmsClient(config) {
  return new SmsClient(config.provider, config.apiKey, { apiUsername: config.apiUsername, apiBaseUrl: config.apiBaseUrl, onDebug: config.onDebug });
}
