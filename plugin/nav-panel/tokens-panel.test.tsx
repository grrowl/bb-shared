// Tests for the reworked tokens panel (issue 35). No DOM harness is wired up
// in this repo, so we render with react-dom/server and assert the markup,
// stubbing the SDK hooks and the PermSegment primitive so the row's wiring is
// observable without a live tree.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PermSegmentProps } from "../components/ui/perm-segment";
import type { Token } from "../server";

// Hoisted spies + the last PermSegment props, shared with the mock factories.
const h = vi.hoisted(() => ({
  rpcCall: vi.fn<(method: string, params: unknown) => Promise<unknown>>(() =>
    Promise.resolve(undefined),
  ),
  toThread: vi.fn(),
  openUrl: vi.fn(),
  segment: { props: null as PermSegmentProps | null },
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: h.rpcCall }),
  useRealtime: () => {},
  useBbNavigate: () => ({ toThread: h.toThread, openUrl: h.openUrl }),
}));

// Stub the segment: record its props (so onChange is drivable) and render a
// recognizable radiogroup carrying the value it was given.
vi.mock("../components/ui/perm-segment.js", () => ({
  PermSegment: (props: PermSegmentProps) => {
    h.segment.props = props;
    return React.createElement("div", {
      role: "radiogroup",
      "aria-label": props["aria-label"],
      "data-value": props.value,
      "data-disabled": props.disabled ? "true" : "false",
    });
  },
}));

// Import after the mocks are registered.
import { ShareRow, TokenCard, summaryPerm } from "./tokens-panel";

const share = (
  over: Partial<Token["shares"][number]> = {},
): Token["shares"][number] => ({
  thread_id: "thr_abc",
  project_id: "prj_1",
  perm: "read",
  added_at: 0,
  title: "Roadmap",
  ...over,
});

const token = (over: Partial<Token> = {}): Token => ({
  id: "tok_1",
  hash: "hash_1",
  label: "Head of Product",
  shares: [share()],
  created_at: 0,
  url: "https://guest.example/tok_1",
  ...over,
});

beforeEach(() => {
  h.rpcCall.mockClear();
  h.toThread.mockClear();
  h.openUrl.mockClear();
  h.segment.props = null;
});

function renderRow(s: Token["shares"][number]): string {
  return renderToStaticMarkup(
    <ul>
      <ShareRow tokenId="tok_1" share={s} onChanged={vi.fn()} onError={vi.fn()} />
    </ul>,
  );
}

describe("summaryPerm", () => {
  it("is null when the link has no shares", () => {
    expect(summaryPerm([])).toBeNull();
  });

  it("is read when every share is read", () => {
    expect(summaryPerm([share(), share({ thread_id: "thr_b" })])).toBe("read");
  });

  it("is write when any share is write", () => {
    expect(
      summaryPerm([share(), share({ thread_id: "thr_b", perm: "write" })]),
    ).toBe("write");
  });
});

describe("ShareRow", () => {
  it("shows the thread title, not the id, and keeps the id as the tooltip", () => {
    const html = renderRow(share({ title: "Roadmap", thread_id: "thr_abc" }));
    expect(html).toContain(">Roadmap</button>");
    expect(html).toContain('title="Open thread thr_abc"');
    expect(html).not.toContain(">thr_abc</button>");
  });

  it("renders the perm segment bound to the share's perm", () => {
    const html = renderRow(share({ perm: "write" }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('data-value="write"');
    expect(h.segment.props?.value).toBe("write");
  });

  it("drops the perm chip and the Upgrade/Downgrade/remove controls", () => {
    const html = renderRow(share({ perm: "read" }));
    expect(html).not.toContain("Upgrade");
    expect(html).not.toContain("Downgrade");
    expect(html).not.toContain("Remove thread from link");
    // The old uppercase perm chip rendered the bare word; the segment does not.
    expect(html).not.toMatch(/>read<\/span>/);
  });

  it("revokes via removeShare when the segment goes off", async () => {
    renderRow(share({ thread_id: "thr_abc", perm: "read" }));
    h.segment.props?.onChange("off");
    await Promise.resolve();
    expect(h.rpcCall).toHaveBeenCalledWith("removeShare", {
      token_id: "tok_1",
      thread_id: "thr_abc",
    });
  });

  it("grants via updateShare when the segment picks read or write", async () => {
    renderRow(share({ thread_id: "thr_abc", perm: "read" }));
    h.segment.props?.onChange("write");
    await Promise.resolve();
    expect(h.rpcCall).toHaveBeenCalledWith("updateShare", {
      token_id: "tok_1",
      thread_id: "thr_abc",
      perm: "write",
    });
  });
});

describe("TokenCard", () => {
  function renderCard(t: Token): string {
    return renderToStaticMarkup(
      <ul>
        <TokenCard
          token={t}
          onChanged={vi.fn()}
          onFlash={vi.fn()}
          onError={vi.fn()}
        />
      </ul>,
    );
  }

  it("enables Copy URL when the link has a session url", () => {
    const html = renderCard(token({ url: "https://guest.example/tok_1" }));
    expect(html).toContain("Copy URL");
    expect(html).toContain('title="Copy the guest link"');
    // No control renders a `disabled` attribute (the class utilities like
    // `disabled:opacity-50` are not the attribute).
    expect(html).not.toContain('disabled=""');
  });

  it("disables Copy URL with a plain hint when the url is absent", () => {
    const html = renderCard(token({ url: undefined }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="Create the link again to copy it"');
  });

  it("shows the derived perm summary badge for a link with shares", () => {
    const html = renderCard(
      token({ shares: [share({ perm: "write" })] }),
    );
    expect(html).toContain(">write</span>");
  });

  it("omits the badge when the link has no shares", () => {
    const html = renderCard(token({ shares: [] }));
    expect(html).not.toMatch(/>(read|write)<\/span>/);
    expect(html).toContain("No threads on this link yet.");
  });

  it("keeps the delete confirmation copy", () => {
    const html = renderCard(token());
    expect(html).toContain(`Delete link ${token().label}`);
  });
});
