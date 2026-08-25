import { describe, it, expect } from "vitest";
import { connectionsForPush, type PushRoutingConnection } from "./pushRouting.js";

describe("connectionsForPush", () => {
  it("delivers to a connection whose key list includes the entity's key, unbound", () => {
    const conns: PushRoutingConnection[] = [{ epId: "a", serverId: "serverA", keys: ["home"], key: "home" }];
    expect(connectionsForPush(null, conns)).toEqual([{ epId: "a", key: "home" }]);
  });

  it("skips a connection whose key list does not include the entity's key", () => {
    const conns: PushRoutingConnection[] = [{ epId: "a", serverId: "serverA", keys: ["home"], key: "board-key" }];
    expect(connectionsForPush(null, conns)).toEqual([]);
  });

  it("a board bound to server A is not pushed to a connection on server B, even though B has the key", () => {
    const conns: PushRoutingConnection[] = [
      { epId: "toA", serverId: "serverA", keys: ["boardKey"], key: "boardKey" },
      { epId: "toB", serverId: "serverB", keys: ["boardKey"], key: "boardKey" },
    ];
    expect(connectionsForPush("serverA", conns)).toEqual([{ epId: "toA", key: "boardKey" }]);
  });

  it("a home-namespace entity (key always present) is still withheld from a connection bound to a different server", () => {
    // This is the case the binding check exists for: the key guard alone
    // could never catch it, because the home key is unconditionally in
    // every connection's keys list.
    const conns: PushRoutingConnection[] = [
      { epId: "toA", serverId: "serverA", keys: ["home"], key: "home" },
      { epId: "toB", serverId: "serverB", keys: ["home"], key: "home" },
    ];
    expect(connectionsForPush("serverA", conns)).toEqual([{ epId: "toA", key: "home" }]);
  });

  it("an unbound (null) board's entity reaches every connection that has the key", () => {
    const conns: PushRoutingConnection[] = [
      { epId: "toA", serverId: "serverA", keys: ["boardKey"], key: "boardKey" },
      { epId: "toB", serverId: "serverB", keys: ["boardKey"], key: "boardKey" },
    ];
    expect(connectionsForPush(null, conns)).toEqual([
      { epId: "toA", key: "boardKey" },
      { epId: "toB", key: "boardKey" },
    ]);
  });

  it("two endpoints on the same server_id both receive the push (claimOrDefer's one-primary-per-server collapse happens upstream, not here)", () => {
    const conns: PushRoutingConnection[] = [
      { epId: "tailnet", serverId: "serverA", keys: ["boardKey"], key: "boardKey" },
      { epId: "public", serverId: "serverA", keys: ["boardKey"], key: "boardKey" },
    ];
    expect(connectionsForPush("serverA", conns)).toHaveLength(2);
  });

  it("a brand-new key not yet in a connection's hello is skipped there but would still reach a connection that already has it", () => {
    const conns: PushRoutingConnection[] = [
      { epId: "stale", serverId: "serverA", keys: ["home"], key: "freshKey" },
      { epId: "current", serverId: "serverA", keys: ["home", "freshKey"], key: "freshKey" },
    ];
    expect(connectionsForPush(null, conns)).toEqual([{ epId: "current", key: "freshKey" }]);
  });

  it("returns nothing for no connections", () => {
    expect(connectionsForPush(null, [])).toEqual([]);
  });
});
