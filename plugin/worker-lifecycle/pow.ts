// Proof-of-work solver for Cloudflare's anonymous temp-account provisioning
// (spike 01, `research/cf-temp-deployments.md` §"Path B").
//
// The provisioning `/challenge` endpoint hands back `{ challengeToken, seed, k,
// g }` with `k * g ≤ 64,000,000`. The solution is a chain of `k + 1` 32-byte
// SHA-256 checkpoints: checkpoint[0] is the seed, and each subsequent
// checkpoint is `g` rounds of SHA-256 applied to the previous one. The
// concatenated checkpoints, base64-encoded, are the `solution.checkpoints`
// value posted back to `/previews`.
//
// Pure + deterministic so it is unit-testable without hitting Cloudflare (no
// CF egress in the sandbox — see the spike's "Blocker" section). The only
// assumption we cannot verify offline is the `seed` wire encoding; CF returns
// it base64-encoded, matching how the checkpoints go back out.
import { createHash } from "node:crypto";

export interface PowChallenge {
  challengeToken: string;
  /** Base64-encoded 32-byte seed — checkpoint[0]. */
  seed: string;
  /** Number of segments (→ k+1 checkpoints). */
  k: number;
  /** SHA-256 rounds per segment. */
  g: number;
}

export interface PowSolution {
  challengeToken: string;
  solution: { checkpoints: string };
}

/** Hard cap from CF: `k * g` must not exceed 64M SHA-256 iterations. */
export const POW_MAX_ITERATIONS = 64_000_000;

function sha256(input: Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

/** Apply SHA-256 `rounds` times, chaining each 32-byte digest into the next. */
function iterate(from: Buffer, rounds: number): Buffer {
  let cur = from;
  for (let i = 0; i < rounds; i++) cur = sha256(cur);
  return cur;
}

/**
 * Build the base64 checkpoint chain for a raw 32-byte seed. Exposed separately
 * from {@link solveChallenge} so tests can exercise the chaining against known
 * byte inputs without a base64 round-trip.
 */
export function solvePow(seed: Buffer, k: number, g: number): string {
  if (!Number.isInteger(k) || k < 0) {
    throw new Error(`PoW: invalid segment count k=${k}`);
  }
  if (!Number.isInteger(g) || g < 0) {
    throw new Error(`PoW: invalid rounds-per-segment g=${g}`);
  }
  if (k * g > POW_MAX_ITERATIONS) {
    throw new Error(
      `PoW: difficulty k*g=${k * g} exceeds the ${POW_MAX_ITERATIONS} cap`,
    );
  }
  const checkpoints: Buffer[] = [seed];
  let cur = seed;
  for (let i = 0; i < k; i++) {
    cur = iterate(cur, g);
    checkpoints.push(cur);
  }
  return Buffer.concat(checkpoints).toString("base64");
}

/** Decode a challenge's base64 seed and produce the postable solution body. */
export function solveChallenge(challenge: PowChallenge): PowSolution {
  const seed = Buffer.from(challenge.seed, "base64");
  if (seed.length === 0) {
    throw new Error("PoW: challenge seed decoded to zero bytes");
  }
  return {
    challengeToken: challenge.challengeToken,
    solution: { checkpoints: solvePow(seed, challenge.k, challenge.g) },
  };
}
