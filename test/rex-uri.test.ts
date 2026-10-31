import { expect, it } from "@effect/vitest";
import { hostname } from "node:os";
import { localDirectoryUri } from "../src/rex.ts";

it("terminal directory reports accept this machine's OSC7 authority but reject remote hosts", () => {
  const local = hostname()
    .replace(/\.$/, "")
    .replace(/\.local$/i, "");
  expect(localDirectoryUri(`file://${local}.local/tmp/project%20one`)).toBe(
    "/tmp/project one",
  );
  expect(localDirectoryUri(`file://${local}/tmp/project`)).toBe("/tmp/project");
  expect(localDirectoryUri("file:///tmp/project")).toBe("/tmp/project");
  expect(localDirectoryUri("file://localhost/tmp/project")).toBe(
    "/tmp/project",
  );
  expect(
    localDirectoryUri("file://remote.invalid/tmp/project"),
  ).toBeUndefined();
  expect(localDirectoryUri("file:///tmp/project%00")).toBeUndefined();
});
