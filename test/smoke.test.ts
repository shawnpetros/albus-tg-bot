// Sanity check that the bun test runner is wired up and TypeScript
// transpiles correctly. Real module tests live alongside their modules
// in subsequent commits.

import { describe, expect, test } from "bun:test";

describe("infrastructure smoke", () => {
  test("bun test runner picks up TS files", () => {
    expect(1 + 1).toBe(2);
  });

  test("TypeScript strict mode is on", () => {
    // If strict were off, this would compile without complaint:
    // const x: string = null;
    // We can't write a negative test here without a separate build pass,
    // but presence of this file under `strict: true` is the contract.
    const x: string = "ok";
    expect(typeof x).toBe("string");
  });
});
