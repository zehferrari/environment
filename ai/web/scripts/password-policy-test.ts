import assert from "node:assert/strict";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordLengthError,
} from "../lib/auth/password";

assert.equal(MIN_PASSWORD_LENGTH, 6, "minimum password length is 6");
assert.equal(MAX_PASSWORD_LENGTH, 256, "password length matches the login credential cap");
assert.equal(passwordLengthError("x".repeat(MIN_PASSWORD_LENGTH - 1)), "short", "short passwords are rejected");
assert.equal(passwordLengthError("x".repeat(MIN_PASSWORD_LENGTH)), null, "minimum-length passwords are accepted");
assert.equal(passwordLengthError("x".repeat(MAX_PASSWORD_LENGTH)), null, "maximum-length passwords are accepted");
assert.equal(passwordLengthError("x".repeat(MAX_PASSWORD_LENGTH + 1)), "long", "oversized passwords are rejected");

console.log("password-policy-test: ok");
