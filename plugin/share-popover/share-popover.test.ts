// Unit tests for the share popover's recipient-first decision logic (issue 34).
// No DOM harness is wired up in this repo, so — as with perm-segment.test.tsx —
// we test the pure helpers the component drives its rpc calls off, rather than
// mounting the component.
import { describe, expect, it } from "vitest";

import type { Perm, Share, Token } from "../server.js";
import { derivedPerm, resolveShareAction } from "./share-popover.js";

/** A stored share on some thread, at `perm`. */
function share(thread_id: string, perm: Perm): Share {
  return {
    thread_id,
    project_id: "p1",
    perm,
    added_at: 0,
    title: thread_id,
  };
}

/** A token holding the given shares. */
function token(shares: Share[]): Token {
  return {
    id: "t1",
    hash: "h",
    label: "brave-otter",
    shares,
    created_at: 0,
    url: "https://example.test/t1",
  };
}

describe("derivedPerm", () => {
  it("is null for a link with no threads", () => {
    expect(derivedPerm(token([]))).toBeNull();
  });

  it("is read when every share is read", () => {
    expect(derivedPerm(token([share("a", "read"), share("b", "read")]))).toBe(
      "read",
    );
  });

  it("is write when any share is write", () => {
    expect(
      derivedPerm(token([share("a", "read"), share("b", "write")])),
    ).toBe("write");
  });
});

describe("resolveShareAction", () => {
  it("off on an unshared thread is a no-op", () => {
    expect(resolveShareAction(undefined, "off")).toEqual({ kind: "none" });
  });

  it("off on a shared thread removes it", () => {
    expect(resolveShareAction("read", "off")).toEqual({ kind: "remove" });
    expect(resolveShareAction("write", "off")).toEqual({ kind: "remove" });
  });

  it("read/write on an unshared thread adds at that perm", () => {
    expect(resolveShareAction(undefined, "read")).toEqual({
      kind: "add",
      perm: "read",
    });
    expect(resolveShareAction(undefined, "write")).toEqual({
      kind: "add",
      perm: "write",
    });
  });

  it("read/write on a shared thread updates to that perm", () => {
    expect(resolveShareAction("read", "write")).toEqual({
      kind: "update",
      perm: "write",
    });
    expect(resolveShareAction("write", "read")).toEqual({
      kind: "update",
      perm: "read",
    });
  });
});
