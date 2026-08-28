import { describe, it, expect } from "vitest";
import { variantAllowed } from "./variantGuard.js";

describe("variantAllowed", () => {
  it("allows a matching variant", () => {
    expect(variantAllowed("prod", "prod")).toBe(true);
    expect(variantAllowed("dev", "dev")).toBe(true);
  });

  it("rejects a mismatched variant", () => {
    expect(variantAllowed("prod", "dev")).toBe(false);
    expect(variantAllowed("dev", "prod")).toBe(false);
  });

  it("allows an unknown (undefined) variant, for an older server", () => {
    expect(variantAllowed(undefined, "dev")).toBe(true);
    expect(variantAllowed(undefined, "prod")).toBe(true);
  });
});
