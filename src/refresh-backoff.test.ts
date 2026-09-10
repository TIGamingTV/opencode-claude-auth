import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  classifyRefreshFailure,
  computeBackoffMs,
  noteRefreshTransient,
  noteRefreshTerminal,
  clearRefreshOutcome,
  isRefreshCooldownActive,
  getRefreshCooldownUntil,
  getRefreshFailureKind,
  resetRefreshBackoffState,
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
} from "./refresh-backoff.ts"

const SRC = "Claude Code-credentials"

describe("refresh-backoff", () => {
  beforeEach(() => resetRefreshBackoffState())

  describe("classifyRefreshFailure", () => {
    it("treats rate limiting as transient", () => {
      assert.equal(classifyRefreshFailure(429, "rate_limit_error"), "transient")
      assert.equal(classifyRefreshFailure(429), "transient")
    })

    it("treats server errors and network failures as transient", () => {
      assert.equal(classifyRefreshFailure(500), "transient")
      assert.equal(classifyRefreshFailure(503), "transient")
      assert.equal(classifyRefreshFailure(0), "transient") // network / no response
    })

    it("treats a revoked/invalid refresh token as terminal", () => {
      assert.equal(classifyRefreshFailure(400, "invalid_grant"), "terminal")
      assert.equal(classifyRefreshFailure(401, "invalid_client"), "terminal")
      assert.equal(
        classifyRefreshFailure(400, "unauthorized_client"),
        "terminal",
      )
      assert.equal(
        classifyRefreshFailure(400, "unsupported_grant_type"),
        "terminal",
      )
    })

    it("defaults unknown 4xx to transient (never a spurious hard error)", () => {
      assert.equal(classifyRefreshFailure(400, "something_new"), "transient")
      assert.equal(classifyRefreshFailure(418), "transient")
    })
  })

  describe("computeBackoffMs", () => {
    it("honors an explicit retry-after over the exponential schedule", () => {
      assert.equal(
        computeBackoffMs(1, { retryAfterMs: 12_345, rng: () => 0 }),
        12_345,
      )
    })

    it("clamps a large retry-after to the cap", () => {
      // A server sending Retry-After: 3600 must not pin the cooldown to an hour.
      assert.equal(
        computeBackoffMs(1, { retryAfterMs: 3_600_000, rng: () => 0 }),
        MAX_COOLDOWN_MS,
      )
    })

    it("grows exponentially with consecutive failures and is capped", () => {
      const a = computeBackoffMs(1, { rng: () => 0 })
      const b = computeBackoffMs(2, { rng: () => 0 })
      const c = computeBackoffMs(99, { rng: () => 0 })
      assert.ok(b > a, "second failure backs off longer")
      assert.ok(c <= MAX_COOLDOWN_MS, "backoff is capped")
      assert.ok(a >= BASE_COOLDOWN_MS / 2, "first backoff near the base floor")
    })

    it("applies jitter within the [50%, 100%] band of the scheduled delay", () => {
      const low = computeBackoffMs(1, { rng: () => 0 })
      const high = computeBackoffMs(1, { rng: () => 1 })
      assert.ok(high > low, "rng=1 yields a larger delay than rng=0")
      assert.ok(low >= BASE_COOLDOWN_MS * 0.5)
      assert.ok(high <= BASE_COOLDOWN_MS)
    })
  })

  // Regression pin: MAX_COOLDOWN_MS gates isRefreshCooldownActive, which
  // refreshIfNeeded consults on the REACTIVE path too (a real user request
  // within 60s of token expiry). A single-instance account with no sibling
  // to adopt a fresh token from is refused a refresh attempt for as long as
  // this is set to, so a value here in the tens-of-minutes range turns one
  // transient blip into an apparently-dead plugin for that whole window. An
  // earlier revision raised the default to 30 minutes to throttle the
  // proactive timer (opencode-claude-auth#270) and broke exactly this —
  // reported as "the plugin does nothing when I send a prompt". That fix now
  // lives in index.ts's own proactive-only skip counter instead, which never
  // touches this constant. Keep the default well under a minute.
  it("defaults to a short ceiling so a reactive request is never locked out for long", () => {
    assert.ok(
      MAX_COOLDOWN_MS <= 60_000,
      `MAX_COOLDOWN_MS default is ${MAX_COOLDOWN_MS}ms — this gates real user ` +
        `requests via refreshIfNeeded's reactive path, not just the proactive ` +
        `timer, so it must stay short. Throttle the proactive timer separately.`,
    )
  })

  describe("cooldown lifecycle", () => {
    it("activates a cooldown on a transient failure and reports the failure kind", () => {
      const now = 1_000_000
      const ms = noteRefreshTransient(SRC, { now, rng: () => 0 })
      assert.ok(ms > 0)
      assert.equal(isRefreshCooldownActive(SRC, now + 1), true)
      assert.equal(isRefreshCooldownActive(SRC, now + ms + 1), false)
      assert.equal(getRefreshCooldownUntil(SRC), now + ms)
      assert.equal(getRefreshFailureKind(SRC), "transient")
    })

    it("escalates the cooldown across consecutive transient failures", () => {
      const now = 1_000_000
      const first = noteRefreshTransient(SRC, { now, rng: () => 0 })
      const second = noteRefreshTransient(SRC, { now, rng: () => 0 })
      assert.ok(second > first, "consecutive transients back off further")
    })

    it("records a terminal failure without a cooldown", () => {
      noteRefreshTerminal(SRC)
      assert.equal(getRefreshFailureKind(SRC), "terminal")
      assert.equal(isRefreshCooldownActive(SRC, Date.now()), false)
    })

    it("clears cooldown, consecutive count, and failure kind on success", () => {
      const now = 1_000_000
      noteRefreshTransient(SRC, { now, rng: () => 0 })
      noteRefreshTransient(SRC, { now, rng: () => 0 })
      clearRefreshOutcome(SRC)
      assert.equal(isRefreshCooldownActive(SRC, now + 1), false)
      assert.equal(getRefreshFailureKind(SRC), null)
      // consecutive count reset: the next transient starts from the base again
      const afterReset = noteRefreshTransient(SRC, { now, rng: () => 0 })
      const firstEver = (() => {
        resetRefreshBackoffState()
        return noteRefreshTransient(SRC, { now, rng: () => 0 })
      })()
      assert.equal(afterReset, firstEver)
    })

    it("honors a retry-after hint when setting the cooldown", () => {
      const now = 1_000_000
      const ms = noteRefreshTransient(SRC, {
        now,
        retryAfterMs: 25_000,
        rng: () => 0,
      })
      assert.equal(ms, 25_000)
      assert.equal(getRefreshCooldownUntil(SRC), now + 25_000)
    })
  })
})
