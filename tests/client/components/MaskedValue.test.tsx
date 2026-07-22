import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MaskedValue } from "../../../src/client/components/MaskedValue.js";
import { IdentityProvider } from "../../../src/client/api/identity.js";
import type { Identity } from "../../../src/client/api/types.js";

function asRole(role: Identity["role"], ui: ReactNode) {
  const me = async () => ({
    userId: "u1",
    email: "badger@example.com",
    householdId: "hh-a",
    role,
  });
  return render(<IdentityProvider api={{ me } as never}>{ui}</IdentityProvider>);
}

describe("MaskedValue", () => {
  it("renders the masked form initially", () => {
    render(<MaskedValue masked="••••X4T2" onReveal={async () => "ABCDX4T2"} />);
    expect(screen.getByRole("button")).toHaveTextContent("••••X4T2");
  });

  it("reveals the plaintext on click", async () => {
    render(<MaskedValue masked="••••X4T2" onReveal={async () => "ABCDX4T2"} />);
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("ABCDX4T2")).toBeInTheDocument();
  });

  it("calls onReveal exactly once across repeated clicks", async () => {
    const onReveal = vi.fn(async () => "ABCDX4T2");
    render(<MaskedValue masked="••••X4T2" onReveal={onReveal} />);
    const button = screen.getByRole("button");
    await userEvent.click(button);
    await userEvent.click(button);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when there is no value", () => {
    const { container } = render(<MaskedValue masked={null} onReveal={async () => null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers no reveal affordance to a viewer", async () => {
    const onReveal = vi.fn(async () => "ABCDX4T2");
    asRole("viewer", <MaskedValue masked="••••X4T2" onReveal={onReveal} />);

    // Re-query on every poll rather than holding an element across the
    // re-render. `useCanReveal` fails open while /api/me is in flight, so the
    // first paint is a <button> and the settled paint is a <span>; an element
    // captured by findByText() before the identity resolves is detached by the
    // time it is asserted on. Asserting both conditions inside one waitFor
    // also pins them to the same settled state.
    await vi.waitFor(() => {
      expect(screen.getByText("••••X4T2")).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("reports a rejected reveal instead of throwing", async () => {
    render(
      <MaskedValue
        masked="••••X4T2"
        onReveal={async () => {
          throw new Error("403");
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText(/not allowed to see this/i)).toBeInTheDocument();
  });
});
