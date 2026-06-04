import assert from "node:assert/strict";
import { anonymousTypingLabel } from "../components/streaming-agent-reply";

assert.equal(anonymousTypingLabel(1), "🤖 typing");
assert.equal(anonymousTypingLabel(2), "🤖 + 🤖 typing");
assert.equal(anonymousTypingLabel(0), "🤖 typing");
assert.equal(anonymousTypingLabel(8), "🤖 + 🤖 + 🤖 + 🤖 typing");

console.log("pm typing presence label tests passed");
