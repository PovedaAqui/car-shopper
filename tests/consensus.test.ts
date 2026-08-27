import { describe, expect, it } from "vitest";
import { resolve, consensusAll } from "../worker/consensus.ts";

describe("consensus", () => {
  it("agrees when both passes match", () => {
    const row = resolve("x", "bien", "bien");
    expect(row.badge).toBe("consenso");
    expect(row.agreed).toBe(true);
    expect(row.resolvedState).toBe("bien");
  });

  it("takes the severe state on discrepancy", () => {
    const row = resolve("x", "bien", "mal");
    expect(row.badge).toBe("discrepancia");
    expect(row.resolvedState).toBe("mal");
    expect(row.agreed).toBe(false);
  });

  it("marks no_evaluable when a pass cannot judge", () => {
    const row = resolve("x", "regular", "no_evaluable");
    expect(row.badge).toBe("no_evaluable");
    expect(row.resolvedState).toBe("regular");
  });

  it("runs over a full listing set", () => {
    const rows = consensusAll(
      ["a", "b"],
      new Map([["a", "bien"], ["b", "mal"]]),
      new Map([["a", "bien"], ["b", "regular"]])
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].badge).toBe("consenso");
    expect(rows[1].resolvedState).toBe("mal");
  });
});
