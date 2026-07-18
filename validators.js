// Validatori con checksum ufficiali — deterministici, nessuna dipendenza

export function validIban(raw) {
  const iban = String(raw).replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const s = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of s) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    rem = Number(String(rem) + v) % 97;
  }
  return rem === 1;
}

export function validPiva(raw) {
  const p = String(raw).replace(/\s+/g, "");
  if (!/^\d{11}$/.test(p)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let d = +p[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === +p[10];
}

const CF_ODD = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };

export function validCf(raw) {
  const cf = String(raw).replace(/\s+/g, "").toUpperCase();
  // [A-Z0-9] nelle posizioni numeriche: copre anche i codici con omocodia
  if (!/^[A-Z]{6}[A-Z0-9]{2}[A-Z][A-Z0-9]{2}[A-Z][A-Z0-9]{3}[A-Z]$/.test(cf)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = cf[i];
    sum += i % 2 === 0 ? CF_ODD[ch] : ch >= "0" && ch <= "9" ? +ch : ch.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === cf[15];
}
