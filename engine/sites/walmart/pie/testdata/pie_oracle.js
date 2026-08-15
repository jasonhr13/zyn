"use strict";

// Oracle implementation copied from browser PIE flow (protect=true path).
const PIE = { L: 6, E: 4, K: "", key_id: "", phase: 0 };

const i = {
  base10: "0123456789",
  luhn(t) {
    let r = t.length - 1;
    let e = 0;
    while (r >= 0) {
      e += parseInt(t.substr(r, 1), 10);
      r -= 2;
    }
    for (r = t.length - 2; r >= 0; ) {
      const n = 2 * parseInt(t.substr(r, 1), 10);
      e += n < 10 ? n : n - 9;
      r -= 2;
    }
    return e % 10;
  },
  fixluhn(t, r, e) {
    let n = i.luhn(t);
    if (n < e) n += 10 - e;
    else n -= e;
    if (n !== 0) {
      n = (t.length - r) % 2 !== 0 ? 10 - n : n % 2 === 0 ? 5 - n / 2 : (9 - n) / 2 + 5;
      return t.substr(0, r) + n + t.substr(r + 1);
    }
    return t;
  },
  distill(t) {
    let r = "";
    for (let e = 0; e < t.length; ++e) {
      if (i.base10.indexOf(t.charAt(e)) >= 0) r += t.substr(e, 1);
    }
    return r;
  },
  reformat(t, r) {
    let e = "";
    let n = 0;
    for (let o = 0; o < r.length; ++o) {
      if (n < t.length && i.base10.indexOf(r.charAt(o)) >= 0) {
        e += t.substr(n, 1);
        ++n;
      } else {
        e += r.substr(o, 1);
      }
    }
    return e;
  },
};

const o = { cipher: {} };
o.cipher.aes = function (t) {
  this._tables[0][0][0] || this._precompute();
  let r, e, n, i, a;
  const f = this._tables[0][4];
  const l = this._tables[1];
  const s = t.length;
  let u = 1;
  if (4 !== s && 6 !== s && 8 !== s) throw new Error("invalid aes key size");
  for (this._key = [i = t.slice(0), a = []], r = s; r < 4 * s + 28; r++) {
    n = i[r - 1];
    if (r % s === 0 || (8 === s && r % s === 4)) {
      n = f[n >>> 24] << 24 ^ f[n >> 16 & 255] << 16 ^ f[n >> 8 & 255] << 8 ^ f[255 & n];
      if (r % s === 0) {
        n = n << 8 ^ n >>> 24 ^ u << 24;
        u = u << 1 ^ (u >> 7) * 283;
      }
    }
    i[r] = i[r - s] ^ n;
  }
  for (e = 0; r; e++, r--) {
    n = i[3 & e ? r : r - 4];
    if (r <= 4 || e < 4) a[e] = n;
    else a[e] = l[0][f[n >>> 24]] ^ l[1][f[n >> 16 & 255]] ^ l[2][f[n >> 8 & 255]] ^ l[3][f[255 & n]];
  }
};
o.cipher.aes.prototype = {
  encrypt(t) { return this._crypt(t, 0); },
  _tables: [[[], [], [], [], []], [[], [], [], [], []]],
  _precompute() {
    let t, r, e, n, i, o, a, f;
    const l = this._tables[0];
    const s = this._tables[1];
    const u = l[4];
    const h = s[4];
    const c = [];
    const g = [];
    for (t = 0; t < 256; t++) g[(c[t] = t << 1 ^ (t >> 7) * 283) ^ t] = t;
    for (r = e = 0; !u[r]; r ^= 0 === n ? 1 : n, e = 0 === g[e] ? 1 : g[e]) {
      o = (o = e ^ e << 1 ^ e << 2 ^ e << 3 ^ e << 4) >> 8 ^ 255 & o ^ 99;
      u[r] = o;
      h[o] = r;
      f = 0x1010101 * c[i = c[n = c[r]]] ^ 65537 * i ^ 257 * n ^ 0x1010100 * r;
      a = 257 * c[o] ^ 0x1010100 * o;
      for (t = 0; t < 4; t++) {
        l[t][r] = a = a << 24 ^ a >>> 8;
        s[t][o] = f = f << 24 ^ f >>> 8;
      }
    }
    for (t = 0; t < 5; t++) {
      l[t] = l[t].slice(0);
      s[t] = s[t].slice(0);
    }
  },
  _crypt(t, r) {
    if (4 !== t.length) throw new Error("invalid aes block size");
    let e, n, i, a;
    const f = this._key[r];
    let l = t[0] ^ f[0];
    let s = t[r ? 3 : 1] ^ f[1];
    let u = t[2] ^ f[2];
    let h = t[r ? 1 : 3] ^ f[3];
    const c = f.length / 4 - 2;
    let g = 4;
    const v = [0, 0, 0, 0];
    const p = this._tables[r];
    const b = p[0], d = p[1], y = p[2], E = p[3], I = p[4];
    for (a = 0; a < c; a++) {
      e = b[l >>> 24] ^ d[s >> 16 & 255] ^ y[u >> 8 & 255] ^ E[255 & h] ^ f[g];
      n = b[s >>> 24] ^ d[u >> 16 & 255] ^ y[h >> 8 & 255] ^ E[255 & l] ^ f[g + 1];
      i = b[u >>> 24] ^ d[h >> 16 & 255] ^ y[l >> 8 & 255] ^ E[255 & s] ^ f[g + 2];
      h = b[h >>> 24] ^ d[l >> 16 & 255] ^ y[s >> 8 & 255] ^ E[255 & u] ^ f[g + 3];
      g += 4;
      l = e; s = n; u = i;
    }
    for (a = 0; a < 4; a++) {
      v[r ? 3 & -a : a] = I[l >>> 24] << 24 ^ I[s >> 16 & 255] << 16 ^ I[u >> 8 & 255] << 8 ^ I[255 & h] ^ f[g++];
      e = l; l = s; s = u; u = h; h = e;
    }
    return v;
  }
};

const a = {
  HexToWords(t) {
    const r = [0, 0, 0, 0];
    if (t.length !== 32) return null;
    for (let e = 0; e < 4; e++) r[e] = parseInt(t.substr(8 * e, 8), 16);
    return r;
  },
  Hex: "0123456789abcdef",
  WordToHex(t) {
    let r = 32;
    let e = "";
    while (r > 0) {
      r -= 4;
      e += a.Hex.substr(t >>> r & 15, 1);
    }
    return e;
  }
};

const f = {
  MSBnotZero(t) { return (0x7fffffff | t) !== 0x7fffffff; },
  leftShift(t) {
    t[0] = (0x7fffffff & t[0]) << 1 | t[1] >>> 31;
    t[1] = (0x7fffffff & t[1]) << 1 | t[2] >>> 31;
    t[2] = (0x7fffffff & t[2]) << 1 | t[3] >>> 31;
    t[3] = (0x7fffffff & t[3]) << 1;
  },
  const_Rb: 135,
  compute(t, r) {
    const e = [0, 0, 0, 0];
    const n = t.encrypt(e);
    let i = n[0];
    f.leftShift(n);
    if (f.MSBnotZero(i)) n[3] ^= f.const_Rb;
    let o = 0;
    while (o < r.length) {
      e[o >> 2 & 3] ^= (255 & r.charCodeAt(o)) << 8 * (3 - (3 & o));
      if ((15 & ++o) === 0 && o < r.length) {
        const enc = t.encrypt(e);
        e[0] = enc[0]; e[1] = enc[1]; e[2] = enc[2]; e[3] = enc[3];
      }
    }
    if (o === 0 || (15 & o) !== 0) {
      i = n[0];
      f.leftShift(n);
      if (f.MSBnotZero(i)) n[3] ^= f.const_Rb;
      e[o >> 2 & 3] ^= 128 << 8 * (3 - (3 & o));
    }
    e[0] ^= n[0]; e[1] ^= n[1]; e[2] ^= n[2]; e[3] ^= n[3];
    return t.encrypt(e);
  }
};

const l = {
  alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  precompF(t, r, e, n) {
    const i = [0, 0, 0, 0];
    i[0] = 0x1020100 | n >> 16 & 255;
    i[1] = (n >> 8 & 255) << 24 | (255 & n) << 16 | 2560 | (255 & Math.floor(r / 2));
    i[2] = r;
    i[3] = e.length;
    return t.encrypt(i);
  },
  precompb(t, r) {
    let e = Math.ceil(r / 2);
    let n = 0;
    let i = 1;
    while (e > 0) {
      i *= t;
      --e;
      if (i >= 256) {
        i /= 256;
        ++n;
      }
    }
    if (i > 1) ++n;
    return n;
  },
  bnMultiply(t, r, e) {
    let i = 0;
    for (let n = t.length - 1; n >= 0; --n) {
      const o = t[n] * e + i;
      t[n] = o % r;
      i = (o - t[n]) / r;
    }
  },
  bnAdd(t, r, e) {
    for (let n = t.length - 1, i = e; n >= 0 && i > 0; ) {
      const o = t[n] + i;
      t[n] = o % r;
      i = (o - t[n]) / r;
      --n;
    }
  },
  convertRadix(t, r, e, n, i) {
    const o = Array(n).fill(0);
    for (let f = 0; f < r; ++f) {
      l.bnMultiply(o, i, e);
      l.bnAdd(o, i, t[f]);
    }
    return o;
  },
  cbcmacq(t, r, e, n) {
    const i = [t[0], t[1], t[2], t[3]];
    for (let a = 0; 4 * a < e; ) {
      for (let o = 0; o < 4; ++o) {
        i[o] ^= (r[4 * (a + o)] << 24) | (r[4 * (a + o) + 1] << 16) | (r[4 * (a + o) + 2] << 8) | r[4 * (a + o) + 3];
      }
      const enc = n.encrypt(i);
      i[0] = enc[0]; i[1] = enc[1]; i[2] = enc[2]; i[3] = enc[3];
      a += 4;
    }
    return i;
  },
  F(t, r, e, n, i, o, a0, f0, s0) {
    const c = Math.ceil(s0 / 4) + 1;
    let g = (e.length + s0 + 1) & 15;
    if (g > 0) g = 16 - g;
    const v = Array(e.length + g + s0 + 1).fill(0);
    for (let u = 0; u < e.length; u++) v[u] = e.charCodeAt(u);
    v[v.length - s0 - 1] = r;
    const p = l.convertRadix(n, i, f0, s0, 256);
    for (let b = 0; b < s0; b++) v[v.length - s0 + b] = p[b];
    const d = l.cbcmacq(a0, v, v.length, t);
    let y = d;
    const E = Array(2 * c).fill(0);
    for (let u = 0; u < c; ++u) {
      if (u > 0 && (3 & u) === 0) {
        let h = (u >> 2) & 255;
        h |= h << 8 | h << 16 | h << 24;
        y = t.encrypt([d[0] ^ h, d[1] ^ h, d[2] ^ h, d[3] ^ h]);
      }
      E[2 * u] = y[3 & u] >>> 16;
      E[2 * u + 1] = 65535 & y[3 & u];
    }
    return l.convertRadix(E, 2 * c, 65536, o, f0);
  },
  DigitToVal(t, r, e) {
    const n = Array(r);
    for (let o = 0; o < r; o++) {
      const a = parseInt(t.charAt(o), e);
      if (Number.isNaN(a) || !(a < e)) return "";
      n[o] = a;
    }
    return n;
  },
  ValToDigit(t, r) {
    let e = "";
    for (let n = 0; n < t.length; n++) e += l.alphabet[t[n]];
    return e;
  },
  encryptWithCipher(t, r, e, n) {
    const i0 = t.length;
    const o0 = Math.floor(i0 / 2);
    const a0 = l.precompF(e, i0, r, n);
    const f0 = l.precompb(n, i0);
    const s = l.DigitToVal(t, o0, n);
    const u = l.DigitToVal(t.substr(o0), i0 - o0, n);
    if (s === "" || u === "") return "";
    for (let h = 0; h < 5; h++) {
      let c = 0;
      let g = l.F(e, 2 * h, r, u, u.length, s.length, a0, n, f0);
      for (let v = s.length - 1; v >= 0; --v) {
        const p = s[v] + g[v] + c;
        if (p < n) { s[v] = p; c = 0; } else { s[v] = p - n; c = 1; }
      }
      g = l.F(e, 2 * h + 1, r, s, s.length, u.length, a0, n, f0);
      c = 0;
      for (let v = u.length - 1; v >= 0; --v) {
        const p = u[v] + g[v] + c;
        if (p < n) { u[v] = p; c = 0; } else { u[v] = p - n; c = 1; }
      }
    }
    return l.ValToDigit(s, n) + l.ValToDigit(u, n);
  },
  encrypt(t, r, e, n) {
    const i0 = a.HexToWords(e);
    if (i0 == null) return "";
    return l.encryptWithCipher(t, r, new o.cipher.aes(i0), n);
  },
};

i.integrity = function (t, r, e) {
  const n = "\0" + String.fromCharCode(r.length) + r + "\0" + String.fromCharCode(e.length) + e;
  const words = a.HexToWords(t);
  words[3] ^= 1;
  const aes = new o.cipher.aes(words);
  const mac = f.compute(aes, n);
  return a.WordToHex(mac[0]) + a.WordToHex(mac[1]);
};

function protectPANandCVV(cardNumber, cvv, protect) {
  const o0 = i.distill(cardNumber);
  const a0 = i.distill(cvv);
  if (o0.length < 13 || o0.length > 19 || a0.length > 4 || a0.length === 1 || a0.length === 2) return null;
  const f0 = o0.substr(0, PIE.L) + o0.substring(o0.length - PIE.E);
  if (protect === true) {
    const s = i.luhn(o0);
    const u = o0.substring(PIE.L + 1, o0.length - PIE.E);
    const h = l.encrypt(u + a0, f0, PIE.K, 10);
    const c = o0.substr(0, PIE.L) + "0" + h.substr(0, h.length - a0.length) + o0.substring(o0.length - PIE.E);
    const g = i.reformat(i.fixluhn(c, PIE.L, s), cardNumber);
    const v = i.reformat(h.substring(h.length - a0.length), cvv);
    return [g, v, i.integrity(PIE.K, g, v)];
  }
  return null;
}

function setPIE(L, E, K, keyID, phase) {
  PIE.L = L;
  PIE.E = E;
  PIE.K = K;
  PIE.key_id = keyID;
  PIE.phase = phase;
}

const [pan, cvv, L, E, K, keyID, phase] = process.argv.slice(2);
setPIE(parseInt(L, 10), parseInt(E, 10), K, keyID, parseInt(phase, 10));
const result = protectPANandCVV(pan, cvv, true);
if (!result) {
  console.error("encrypt returned null");
  process.exit(1);
}

console.log(JSON.stringify({
  encryptedPan: result[0],
  encryptedCVV: result[1],
  integrityCheck: result[2],
  keyId: PIE.key_id,
  phase: String(PIE.phase),
}));
