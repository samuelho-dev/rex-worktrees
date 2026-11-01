import { expect, it } from "@effect/vitest";
import { hostname } from "node:os";
import { localDirectoryUri } from "../src/rex.ts";

it("terminal directory reports accept local OSC7 URIs and absolute paths, but reject untrusted paths", () => {
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
  expect(localDirectoryUri("/tmp/project one")).toBe("/tmp/project one");
  expect(localDirectoryUri("/tmp/project%20one")).toBe("/tmp/project%20one");
  expect(
    localDirectoryUri("file://remote.invalid/tmp/project"),
  ).toBeUndefined();
  expect(localDirectoryUri("file:///tmp/project%00")).toBeUndefined();
  expect(localDirectoryUri("ssh://localhost/tmp/project")).toBeUndefined();
  expect(localDirectoryUri("file://localhost/tmp/project?query")).toBeUndefined();
  expect(localDirectoryUri("relative/project")).toBeUndefined();
  expect(localDirectoryUri("/tmp/project\0")).toBeUndefined();
});
