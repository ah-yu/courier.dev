import { describe, expect, it } from "vitest";
import { firstFreePort, portFromDevUrl } from "./dev";

describe("portFromDevUrl", () => {
  it("reads the port of a local dev server", () => {
    expect(portFromDevUrl("http://localhost:3003")).toBe(3003);
    expect(portFromDevUrl("http://127.0.0.1:3004/")).toBe(3004);
    expect(portFromDevUrl("http://localhost")).toBe(80);
  });

  it("ignores a deployed address and malformed state", () => {
    expect(portFromDevUrl("https://notes.example.com:8443")).toBeNull();
    expect(portFromDevUrl("not a url")).toBeNull();
    expect(portFromDevUrl(undefined)).toBeNull();
  });
});

describe("firstFreePort", () => {
  it("keeps the first port when it is free", async () => {
    expect(await firstFreePort(3002, async () => true)).toBe(3002);
  });

  it("skips ports that are already bound", async () => {
    const taken = new Set([3002, 3003]);
    expect(await firstFreePort(3002, async (port) => !taken.has(port))).toBe(3004);
  });

  it("fails with the range it tried when every candidate is busy", async () => {
    await expect(firstFreePort(3002, async () => false, 3)).rejects.toThrow("3002..3004");
  });
});
