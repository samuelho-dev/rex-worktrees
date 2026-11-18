import { expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { vi } from "vitest";
import { BlockIdSchema, SessionIdSchema, WindowIdSchema } from "../src/contracts.ts";
import { openPopup, openTerminal } from "../src/rex.ts";

const fixture = vi.hoisted(() => {
  const requests: string[] = [];
  return { fraction: 1, rows: 80, zoomed: false, requests };
});

vi.mock("../src/process.ts", async () => {
  // Vitest hoists this factory before static Effect imports are initialized.
  const { Effect } = await import("effect");
  return { run: (_program: string, args: readonly string[]) => Effect.sync(() => {
    if (args.includes("whoami")) return JSON.stringify({ host_id: "host", endpoint: "unix:///fixture.sock", principal: { transport: "unix" } });
    if (args.includes("client.list")) return JSON.stringify({ clients: [] });
    if (args.includes("session.view")) {
      const pane = { rect: [0, 0, 1, fixture.fraction], block_id: "block" };
      const layout = fixture.fraction === 1 ? pane : { rect: [0, 0, 1, 1], split: {
        before: pane, after: { rect: [0, fixture.fraction, 1, 1 - fixture.fraction], block_id: "other" }
      } };
      return JSON.stringify({ active_window_id: "window", windows: [{ window_id: "window", focused_block_id: "block",
        zoomed_block_id: fixture.zoomed ? "block" : null, layers: [{ layout, blocks: [
          { block_id: "block", flavor: "com.superlogical.terminal.shell" },
          { block_id: "other", flavor: "com.superlogical.terminal.shell" }
        ] }] }] });
    }
    if (args.at(-1) === "size") return JSON.stringify({ columns: 160, rows: fixture.rows });
    if (args.includes("session.new_split")) return JSON.stringify({ block_ids: ["new-pane"] });
    if (args.includes("session.new_layer")) {
      fixture.requests.push(args.at(-1)!);
      return JSON.stringify({ layer_id: "popup", block_ids: ["popup-block"], revision: 1 });
    }
    throw new Error(`Unexpected Rex call: ${args.join(" ")}`);
  }) };
});

it("keeps the popup's cell budget unchanged for whole-window, split and zoomed origins", async () => {
  for (const state of [{ fraction: 1, rows: 80, zoomed: false }, { fraction: 0.5, rows: 40, zoomed: false }, { fraction: 0.5, rows: 80, zoomed: true }]) {
    Object.assign(fixture, state);
    await Effect.runPromise(Effect.provide(openPopup(["/plugin", "popup"], SessionIdSchema.make("session"), {
      blockId: BlockIdSchema.make("block")
    }), BunServices.layer));
    const request = JSON.parse(fixture.requests.at(-1)!);
    expect(request.bounds).toEqual([(1 - 82 / 160) / 2, (1 - 19 / 80) / 2, 82 / 160, 19 / 80]);
    expect(request.layout.block.options.size).toEqual({ columns: 80, rows: 16 });
  }
});

it("keeps the anchor window when native split creation returns only new block IDs", async () => {
  const sessionId = SessionIdSchema.make("session");
  const windowId = WindowIdSchema.make("anchor-window");
  const created = await Effect.runPromise(Effect.provide(openTerminal(
    { kind: "existing", id: sessionId }, "Split", "/repo", ["/bin/sh"],
    { windowId, blockId: BlockIdSchema.make("anchor-pane") }
  ), BunServices.layer));
  expect(created).toEqual({ sessionId, windowId, blockId: "new-pane" });
});
