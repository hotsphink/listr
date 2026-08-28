import { describe, it, expect } from "vitest";
import { keysForEndpoint, type ScopedKeyRow } from "./keyScoping.js";

describe("keysForEndpoint", () => {
  it("always includes the per-server home key, regardless of endpoint", () => {
    const keys = keysForEndpoint("home-for-serverA", [], [], null);
    expect(keys).toEqual(["home-for-serverA"]);
  });

  it("includes an unscoped (server_id null) board key for any endpoint, known or not", () => {
    const boardKeys: ScopedKeyRow[] = [{ key: "board1", server_id: null }];
    expect(keysForEndpoint("home", boardKeys, [], null)).toContain("board1");
    expect(keysForEndpoint("home", boardKeys, [], "serverA")).toContain("board1");
  });

  it("includes a board key scoped to this endpoint's known server, and withholds one scoped elsewhere", () => {
    const boardKeys: ScopedKeyRow[] = [
      { key: "mine", server_id: "serverA" },
      { key: "theirs", server_id: "serverB" },
    ];
    const keys = keysForEndpoint("home", boardKeys, [], "serverA");
    expect(keys).toContain("mine");
    expect(keys).not.toContain("theirs");
  });

  it("withholds a scoped board key from a never-before-connected endpoint (server_id null), which applies to boards too", () => {
    const boardKeys: ScopedKeyRow[] = [{ key: "board1", server_id: "serverA" }];
    expect(keysForEndpoint("home", boardKeys, [], null)).not.toContain("board1");
  });

  it("includes an unscoped (server_id null) roster key for any endpoint, known or not", () => {
    const roster: ScopedKeyRow[] = [{ key: "shared1", server_id: null }];
    expect(keysForEndpoint("home", [], roster, null)).toContain("shared1");
    expect(keysForEndpoint("home", [], roster, "serverA")).toContain("shared1");
  });

  it("includes a scoped roster key only for the endpoint already known to be that server", () => {
    const roster: ScopedKeyRow[] = [{ key: "shared1", server_id: "serverA" }];
    expect(keysForEndpoint("home", [], roster, "serverA")).toContain("shared1");
    expect(keysForEndpoint("home", [], roster, "serverB")).not.toContain("shared1");
  });

  it("withholds a scoped roster key from a never-before-connected endpoint (server_id null)", () => {
    const roster: ScopedKeyRow[] = [{ key: "shared1", server_id: "serverA" }];
    expect(keysForEndpoint("home", [], roster, null)).not.toContain("shared1");
  });

  it("dedupes when a key appears in more than one source", () => {
    const boardKeys: ScopedKeyRow[] = [{ key: "home", server_id: null }];
    const roster: ScopedKeyRow[] = [{ key: "home", server_id: null }];
    const keys = keysForEndpoint("home", boardKeys, roster, null);
    expect(keys.filter((k) => k === "home")).toHaveLength(1);
  });

  it("mixes scoped-to-this-endpoint, unscoped, and excludes scoped-elsewhere across both boards and roster in one call", () => {
    const boardKeys: ScopedKeyRow[] = [
      { key: "myBoard", server_id: "serverA" },
      { key: "otherBoard", server_id: "serverB" },
    ];
    const roster: ScopedKeyRow[] = [
      { key: "mine", server_id: "serverA" },
      { key: "open", server_id: null },
      { key: "theirs", server_id: "serverB" },
    ];
    const keys = keysForEndpoint("home", boardKeys, roster, "serverA");
    expect(keys).toEqual(expect.arrayContaining(["home", "myBoard", "mine", "open"]));
    expect(keys).not.toContain("otherBoard");
    expect(keys).not.toContain("theirs");
  });

  it("a server given no board keys and no roster still gets just its home key (nothing unconditional beyond that)", () => {
    expect(keysForEndpoint("solo-home", [], [], "serverA")).toEqual(["solo-home"]);
  });
});
