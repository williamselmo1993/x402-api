import assert from "node:assert";
import { validIban, validPiva, validCf } from "./validators.js";

// IBAN — vettori noti validi + mutazione
assert.equal(validIban("GB82 WEST 1234 5698 7654 32"), true);
assert.equal(validIban("IT60X0542811101000000123456"), true);
assert.equal(validIban("IT60X0542811101000000123457"), false);
assert.equal(validIban("garbage"), false);

// Partita IVA
assert.equal(validPiva("00743110157"), true);
assert.equal(validPiva("00743110158"), false);
assert.equal(validPiva("123"), false);

// Codice Fiscale
assert.equal(validCf("RSSMRA85T10A562S"), true);
assert.equal(validCf("rssmra85t10a562s"), true);
assert.equal(validCf("RSSMRA85T10A562Z"), false);
assert.equal(validCf("XXX"), false);

console.log("tutti i test passano");
