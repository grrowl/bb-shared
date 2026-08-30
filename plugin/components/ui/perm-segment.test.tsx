// Component tests for PermSegment (issue 33). No DOM harness is wired up in
// this repo, so we assert the rendered markup with react-dom/server and drive
// the interaction handlers off the element tree directly.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PermSegment, type PermValue, type PermSegmentProps } from "./perm-segment";

/** Render the forwardRef body to a plain element tree we can introspect. */
function tree(props: PermSegmentProps): React.ReactElement {
  const render = (
    PermSegment as unknown as {
      render: (
        p: PermSegmentProps,
        ref: React.Ref<HTMLDivElement>,
      ) => React.ReactElement;
    }
  ).render;
  return render(props, null);
}

/** The three radio cells, in DOM order. */
function cells(
  props: PermSegmentProps,
): React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>[] {
  const root = tree(props);
  return React.Children.toArray(
    (root.props as { children: React.ReactNode }).children,
  ) as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>[];
}

const base = (over: Partial<PermSegmentProps> = {}): PermSegmentProps => ({
  value: "off",
  onChange: vi.fn(),
  ...over,
});

/** A synthetic keydown carrying a currentTarget the handler can read. Its
 * parentElement is absent, so the roving-focus call is a safe no-op here. */
function keydown(key: string): React.KeyboardEvent<HTMLButtonElement> {
  return {
    key,
    preventDefault: vi.fn(),
    currentTarget: {} as HTMLButtonElement,
  } as unknown as React.KeyboardEvent<HTMLButtonElement>;
}

describe("PermSegment", () => {
  it("renders a radiogroup with three off/read/write cells", () => {
    const html = renderToStaticMarkup(<PermSegment {...base()} />);
    expect(html).toContain('role="radiogroup"');
    const radios = html.match(/role="radio"/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(html).toContain(">Off</button>");
    expect(html).toContain(">Read</button>");
    expect(html).toContain(">Write</button>");
  });

  it.each<[PermValue, string]>([
    ["off", "Off"],
    ["read", "Read"],
    ["write", "Write"],
  ])("marks only the %s cell checked", (value, label) => {
    const html = renderToStaticMarkup(<PermSegment {...base({ value })} />);
    // Exactly one cell is aria-checked, and it is the labelled one.
    expect(html.match(/aria-checked="true"/g) ?? []).toHaveLength(1);
    const checked = new RegExp(`aria-checked="true"[^>]*>${label}</button>`);
    expect(html).toMatch(checked);
  });

  it("labels the group, defaulting to Permission", () => {
    expect(renderToStaticMarkup(<PermSegment {...base()} />)).toContain(
      'aria-label="Permission"',
    );
    expect(
      renderToStaticMarkup(
        <PermSegment {...base({ "aria-label": "Guest permission" })} />,
      ),
    ).toContain('aria-label="Guest permission"');
  });

  it("gives the selected cell a roving tabindex of 0 and the rest -1", () => {
    const [off, read, write] = cells(base({ value: "read" }));
    expect(off.props.tabIndex).toBe(-1);
    expect(read.props.tabIndex).toBe(0);
    expect(write.props.tabIndex).toBe(-1);
  });

  it("disables every cell and dims the group when disabled", () => {
    const html = renderToStaticMarkup(
      <PermSegment {...base({ disabled: true })} />,
    );
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(3);
    expect(html).toContain("opacity-50");
  });

  it("reports the clicked cell through onChange", () => {
    const onChange = vi.fn();
    const [, read, write] = cells(base({ value: "off", onChange }));
    read.props.onClick?.(
      {} as unknown as React.MouseEvent<HTMLButtonElement>,
    );
    write.props.onClick?.(
      {} as unknown as React.MouseEvent<HTMLButtonElement>,
    );
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["read", "write"]);
  });

  it("does not fire onChange when the selected cell is re-activated", () => {
    const onChange = vi.fn();
    // "read" is already selected; clicking it must be a true no-op so a
    // consumer wired to a network mutation issues no redundant RPC.
    const [, read] = cells(base({ value: "read", onChange }));
    read.props.onClick?.({} as unknown as React.MouseEvent<HTMLButtonElement>);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves selection with arrow keys and wraps around", () => {
    const press = (value: PermValue, key: string): PermValue | undefined => {
      const onChange = vi.fn();
      const [selected] = cells(base({ value, onChange })).filter(
        (c) => c.props["aria-checked"] === true,
      );
      const event = keydown(key);
      selected.props.onKeyDown?.(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      return onChange.mock.calls[0]?.[0] as PermValue | undefined;
    };

    expect(press("off", "ArrowRight")).toBe("read");
    expect(press("read", "ArrowRight")).toBe("write");
    expect(press("write", "ArrowRight")).toBe("off"); // wraps forward
    expect(press("off", "ArrowLeft")).toBe("write"); // wraps backward
    expect(press("read", "ArrowUp")).toBe("off");
    expect(press("read", "ArrowDown")).toBe("write");
  });

  it("ignores unrelated keys", () => {
    const onChange = vi.fn();
    const [, read] = cells(base({ value: "read", onChange }));
    read.props.onKeyDown?.(keydown("Enter"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
