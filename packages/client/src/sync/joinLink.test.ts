import { describe, it, expect } from "vitest";
import { hashServerId, parseJoinPath, parseJoinInput, joinRoutePath, SERVER_HASH_LENGTH } from "./joinLink.js";

describe("hashServerId", () => {
  it("is deterministic and the expected length", async () => {
    const a = await hashServerId("server-abc-123");
    const b = await hashServerId("server-abc-123");
    expect(a).toBe(b);
    expect(a).toHaveLength(SERVER_HASH_LENGTH);
    expect(a).not.toMatch(/[+/=]/); // base64url, not base64
  });

  it("differs for a different server_id", async () => {
    const a = await hashServerId("server-a");
    const b = await hashServerId("server-b");
    expect(a).not.toBe(b);
  });
});

describe("parseJoinPath", () => {
  it("parses a well-formed hash + grantId.secret pair", () => {
    expect(parseJoinPath("AbC123", "grant-1.the-secret")).toEqual({
      serverHash: "AbC123",
      grantId: "grant-1",
      secret: "the-secret",
    });
  });

  it("splits on the first dot, so a UUID grant id (no dots) round-trips exactly", () => {
    const uuid = "511c27e8-b5ae-4560-aba2-3bb2cabb0e20";
    expect(parseJoinPath("AbC123", `${uuid}.kiESmkpIbja8h-Bp`)).toEqual({
      serverHash: "AbC123",
      grantId: uuid,
      secret: "kiESmkpIbja8h-Bp",
    });
  });

  it("returns null when the hash is missing", () => {
    expect(parseJoinPath(undefined, "grant.secret")).toBeNull();
    expect(parseJoinPath("", "grant.secret")).toBeNull();
  });

  it("returns null when credentials is missing", () => {
    expect(parseJoinPath("AbC123", undefined)).toBeNull();
    expect(parseJoinPath("AbC123", "")).toBeNull();
  });

  it("returns null when credentials has no dot", () => {
    expect(parseJoinPath("AbC123", "no-dot-here")).toBeNull();
  });

  it("returns null when the grant id or secret half is empty", () => {
    expect(parseJoinPath("AbC123", ".secret")).toBeNull();
    expect(parseJoinPath("AbC123", "grant.")).toBeNull();
  });

  it("returns null when there's a second dot (ambiguous secret)", () => {
    expect(parseJoinPath("AbC123", "grant.se.cret")).toBeNull();
  });
});

describe("parseJoinInput", () => {
  it("parses a full join URL", () => {
    const url = "https://listr.example/#/join/AbC123/grant-1.the-secret";
    expect(parseJoinInput(url)).toEqual({ serverHash: "AbC123", grantId: "grant-1", secret: "the-secret" });
  });

  it("parses a bare hash/grantId.secret fragment with no URL wrapper", () => {
    expect(parseJoinInput("AbC123/grant-1.the-secret")).toEqual({
      serverHash: "AbC123",
      grantId: "grant-1",
      secret: "the-secret",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseJoinInput("  AbC123/grant-1.the-secret  \n")).toEqual({
      serverHash: "AbC123",
      grantId: "grant-1",
      secret: "the-secret",
    });
  });

  it("returns null for a URL on some other route", () => {
    expect(parseJoinInput("https://listr.example/#/board/sometoken")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseJoinInput("not a link at all")).toBeNull();
    expect(parseJoinInput("")).toBeNull();
  });

  it("returns null for a malformed join URL missing the secret", () => {
    expect(parseJoinInput("https://listr.example/#/join/AbC123/grant-1")).toBeNull();
  });
});

describe("board id in a share link", () => {
  it("picks the board id out of a full URL's query string", () => {
    const url = "https://listr.example/#/join/AbC123/grant-1.the-secret?b=board-9";
    expect(parseJoinInput(url)).toEqual({
      serverHash: "AbC123",
      grantId: "grant-1",
      secret: "the-secret",
      boardId: "board-9",
    });
  });

  it("picks it out of a bare fragment too", () => {
    expect(parseJoinInput("AbC123/grant-1.the-secret?b=board-9")).toEqual({
      serverHash: "AbC123",
      grantId: "grant-1",
      secret: "the-secret",
      boardId: "board-9",
    });
  });

  it("leaves boardId absent when there is no query, so a group share stays unchanged", () => {
    expect(parseJoinInput("AbC123/grant-1.the-secret")).toEqual({
      serverHash: "AbC123",
      grantId: "grant-1",
      secret: "the-secret",
    });
  });

  it("ignores an empty or unrelated query rather than inventing a board", () => {
    expect(parseJoinInput("AbC123/grant-1.the-secret?b=")?.boardId).toBeUndefined();
    expect(parseJoinInput("AbC123/grant-1.the-secret?x=1")?.boardId).toBeUndefined();
  });

  it("keeps the secret intact when a query follows it", () => {
    expect(parseJoinInput("AbC123/grant-1.the-secret?b=board-9")?.secret).toBe("the-secret");
  });

  it("round-trips through joinRoutePath", () => {
    const link = parseJoinInput("AbC123/grant-1.the-secret?b=board-9")!;
    expect(joinRoutePath(link)).toBe("/join/AbC123/grant-1.the-secret?b=board-9");
  });

  it("omits the query in a route path when there is no board", () => {
    const link = parseJoinInput("AbC123/grant-1.the-secret")!;
    expect(joinRoutePath(link)).toBe("/join/AbC123/grant-1.the-secret");
  });
});
