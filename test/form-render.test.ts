import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import type { FormView, InputChoiceState } from "../src/contracts.ts";
import {
  advanceInputChoice,
  naturalFormRows,
  popupTargetRows,
  renderFormFrame,
  renderInputChoice,
} from "../src/ui.ts";

const view: FormView = {
  rows: [
    {
      id: "project",
      label: "Project",
      value: "atelier",
      detail: "/Users/sample/projects/atelier",
    },
    {
      id: "machine",
      label: "Machine",
      value: "Homelab",
      detail: "Host ID: host-remote",
    },
    {
      id: "destination",
      label: "Worktree",
      value: "feature",
      detail: "/Users/sample/projects/atelier.worktrees/feature",
    },
    { id: "branch", label: "Branch", value: "feature" },
    { id: "session", label: "Session", value: "session-123" },
    { id: "mode", label: "Mode", value: "Auto" },
  ],
  submitLabel: "Create worktree & open",
};

describe("persistent form frame", () => {
  it("retains six fields and the input editor at 60x18", () => {
    const frame = renderFormFrame(view, "destination", true, 60, 18, false);
    const editor = renderInputChoice(
      "Worktree",
      { text: "", selected: null },
      [],
      60,
      18,
      false,
    );
    const lines = `${frame}${editor}`.split("\r\n");
    expect(lines).toHaveLength(18);
    for (const row of view.rows)
      expect(frame).toContain(row.label.toUpperCase());
    expect(frame).toContain("Cancel");
    expect(lines.every((line) => Bun.stringWidth(line) <= 60)).toBe(true);
  });

  it("measures unclipped content and fills the allocated card instead of leaving an outer blank strip", () => {
    const required = naturalFormRows(view, 96);
    expect(required).toBeLessThan(32);
    expect(required).toBeGreaterThanOrEqual(view.rows.length + 7);
    const expanded = renderFormFrame(
      view,
      "project",
      false,
      96,
      required + 5,
      false,
    ).split("\r\n");
    expect(expanded).toHaveLength(required + 5);
    expect(expanded.at(-1)).toContain("┘");
  });

  it("keeps initial and populated normal forms aligned, but grows for editors and long paths", () => {
    const initial: FormView = {
      ...view,
      rows: view.rows.map(row => ({
        ...row,
        value: row.id === "project" ? "Choose a project" : row.id === "machine" ? "Choose Rex host" : row.value,
        detail: undefined,
        disabled: true,
      })),
      submitDisabled: true,
    };
    const main = popupTargetRows(view, 96);
    expect(main).toBe(16);
    expect(popupTargetRows(view, 96, true)).toBe(22);
    expect(popupTargetRows(initial, 96)).toBe(main);
    const path = `/Users/sample/${"projects/".repeat(220)}final`;
    const expanded = { ...view, rows: view.rows.map(row => row.id === "destination" ? { ...row, detail: path } : row) };
    const rows = popupTargetRows(expanded, 96);
    expect(rows).toBeGreaterThan(main);
    expect(renderFormFrame(expanded, "destination", false, 96, rows, false)).toContain("final");
  });

  it("keeps validation visible in a compact editor", () => {
    const frame = renderFormFrame(
      {
        ...view,
        error: "Invalid destination ".repeat(12),
      },
      "destination",
      true,
      60,
      18,
      false,
    );
    expect(frame).toContain("Invalid destination");
  });

  it("native sizing warning wraps the actionable reason without replacing primary validation", () => {
    const warning = `Cannot resize popup: ${"native Rex command failed ".repeat(3)}enlarge the floating layer`;
    const compact = {
      ...view,
      error: "Select an exact session",
      fitWarning: warning,
    };
    const frame = renderFormFrame(compact, "session", false, 60, 18, false);
    const content = frame
      .split("\r\n")
      .filter((line) => line.startsWith("│ "))
      .map((line) => line.slice(2, -2).trim())
      .join(" ")
      .replace(/\s+/g, " ");
    expect(content).toContain("Select an exact session");
    expect(content).toContain("Cannot resize popup");
    expect(content).toContain("enlarge the floating layer");
    expect(frame.split("\r\n")).toHaveLength(18);
    expect(
      frame.split("\r\n").every((line) => Bun.stringWidth(line) <= 60),
    ).toBe(true);
    expect(naturalFormRows(compact, 60)).toBeGreaterThan(
      naturalFormRows({ ...compact, fitWarning: undefined }, 60),
    );
  });

  it("a clamped 60x18 editor shows the validation, warning, and preview together", () => {
    const compact = {
      ...view,
      error: "Select an exact session",
      fitWarning: "Enlarge Rex popup to view choices",
    };
    const parent = renderFormFrame(compact, "session", true, 60, 18, false);
    const editor = renderInputChoice(
      "Exact session",
      { text: "", selected: null },
      [],
      60,
      18,
      false,
      true,
    );
    expect(`${parent}${editor}`.split("\r\n")).toHaveLength(18);
    for (const row of view.rows)
      expect(parent).toContain(row.label.toUpperCase());
    expect(parent).toContain("Select an exact session");
    expect(parent).toContain("Enlarge Rex popup");
    expect(parent).toContain("Cancel");
  });

  it("unavailable host renders the full actionable error once within narrow bounds", () => {
    const message =
      "Install the helper on this selected host, then reload its configuration before opening a worktree.";
    const frame = renderFormFrame(
      {
        ...view,
        rows: view.rows.map((row) => ({ ...row, disabled: true })),
        error: message,
        submitDisabled: true,
      },
      "machine",
      false,
      60,
      18,
      false,
    );
    const content = frame
      .split("\r\n")
      .filter((line) => line.startsWith("│ "))
      .map((line) => line.slice(2, -2).trim())
      .join(" ")
      .replace(/\s+/g, " ");
    expect(content.split(message)).toHaveLength(2);
    expect(frame.split("\r\n").length).toBeLessThanOrEqual(18);
    expect(
      frame.split("\r\n").every((line) => Bun.stringWidth(line) <= 60),
    ).toBe(true);
  });

  it("long destination paths with spaces wrap beneath Worktree even when Submit is focused", () => {
    const path =
      "/Users/sample/Library/Application Support/Rex Worktrees/fixtures/feature draft";
    const frame = renderFormFrame(
      {
        ...view,
        rows: view.rows.map(row => row.id === "destination" ? { ...row, detail: path } : row),
      },
      "submit",
      false,
      60,
      18,
      false,
    );
    expect(frame).toContain("/Users/sample/Library");
    expect(frame).toContain("feature draft");
    expect(frame.indexOf("feature draft")).toBeLessThan(frame.indexOf("Create worktree"));
    expect(frame.trimEnd().split("\r\n").length).toBeLessThanOrEqual(18);
  });

  it("keeps plan detail and warning visible without a metadata footer", () => {
    const detail = "Reuse matching tab";
    const warning = "Association lookup unavailable";
    const form = { ...view, notice: `${detail} · ${warning}` };
    const frame = renderFormFrame(form, "submit", false, 96, popupTargetRows(form, 96), false);
    expect(frame).toContain(detail);
    expect(frame).toContain(warning);
  });

  it("resize widens detail without painting beyond the window", () => {
    const narrow = renderFormFrame(view, "project", false, 60, 18, false);
    const wide = renderFormFrame(view, "project", false, 100, 30, false);
    expect(wide).toContain("/Users/sample/projects/atelier");
    expect(narrow.split("\r\n").length).toBeLessThanOrEqual(18);
    expect(
      wide.split("\r\n").every((line) => Bun.stringWidth(line) <= 100),
    ).toBe(true);
  });

  it("editor defaults preserve spaces without displaying control sequences", () => {
    const editor = renderInputChoice(
      "Branch",
      { text: "  feature\x1b[2J  draft\u202e  ", selected: null },
      [],
      60,
      18,
      false,
    );
    expect(editor).toContain("  feature  draft");
    expect(editor).not.toContain("\x1b");
    expect(editor).not.toContain("\u202e");
  });

  it("untrusted Rex labels and paths cannot inject terminal controls", () => {
    const malicious: FormView = {
      ...view,
      rows: view.rows.map((row) =>
        row.id === "project"
          ? { ...row, value: "\x1b[2J\x1b]0;hijack\x07\u202eVISIBLE\nNEXT" }
          : row.id === "destination"
          ? { ...row, detail: "path\x1b[31m\rnext" }
          : row,
      ),
    };
    const frame = renderFormFrame(malicious, "project", false, 60, 18, false);
    expect(frame).not.toContain("\x1b");
    expect(frame).not.toContain("\x07");
    expect(frame).not.toContain("\u202e");
    expect(frame).toContain("NEXT");
  });

  it("NO_COLOR frames have no style sequences", () => {
    expect(renderFormFrame(view, "submit", false, 60, 18, false)).not.toContain(
      "\x1b",
    );
    expect(renderFormFrame(view, "submit", false, 60, 18, true)).toContain(
      "\x1b[36m",
    );
  });
});

describe("inline choice editor", () => {
  const choices = [
    {
      value: { path: "/repo/occupied" },
      title: "occupied",
      description: "/repo/occupied",
    },
    { value: { path: "/repo/feature" }, title: "feature", description: "free" },
  ];
  const key = (name: string, input = "", ctrl = false) => ({
    key: { name, ctrl, shift: false, meta: false },
    input: Option.some(input),
  });

  it("typing a matching name remains a new typed value until arrows select an existing value", () => {
    let state: InputChoiceState = { text: "", selected: null };
    const typed = advanceInputChoice(state, key("f", "feature"), choices);
    expect(typed._tag).toBe("NextFrame");
    if (typed._tag !== "NextFrame") return;
    state = typed.state;
    expect(advanceInputChoice(state, key("enter"), choices)).toEqual({
      _tag: "Submit",
      value: { kind: "typed", text: "feature" },
    });
    const moved = advanceInputChoice(state, key("down"), choices);
    expect(moved._tag).toBe("NextFrame");
    if (moved._tag !== "NextFrame") return;
    expect(advanceInputChoice(moved.state, key("enter"), choices)).toEqual({
      _tag: "Submit",
      value: { kind: "selected", value: choices[1]!.value },
    });
    expect(advanceInputChoice(moved.state, key("x", "🪵"), choices)).toEqual({
      _tag: "NextFrame",
      state: { text: "feature🪵", selected: null },
    });
    expect(
      advanceInputChoice(moved.state, key("paste", "é/木"), choices),
    ).toEqual({ _tag: "NextFrame", state: { text: "featureé/木", selected: null } });
    expect(
      advanceInputChoice(
        { text: "é🪵", selected: null },
        key("backspace"),
        choices,
      ),
    ).toEqual({ _tag: "NextFrame", state: { text: "é", selected: null } });
    expect(
      advanceInputChoice(
        { text: "a👩‍💻", selected: null },
        key("backspace"),
        choices,
      ),
    ).toEqual({ _tag: "NextFrame", state: { text: "a", selected: null } });
    expect(advanceInputChoice(state, key("u", "", true), choices)).toEqual({
      _tag: "NextFrame",
      state: { text: "", selected: null },
    });
    expect(advanceInputChoice(state, key("escape"), choices)).toEqual({
      _tag: "Submit", value: null,
    });
  });

  it("rejects ASCII controls in typed choices without rejecting C1 characters", () => {
    const state: InputChoiceState = { text: "", selected: null };
    expect(advanceInputChoice(state, key("paste", "\x00"), choices)).toEqual({ _tag: "Beep" });
    expect(advanceInputChoice(state, key("paste", "\x7f"), choices)).toEqual({ _tag: "Beep" });
    expect(advanceInputChoice(state, key("paste", "\u0080"), choices)).toEqual({
      _tag: "NextFrame", state: { text: "\u0080", selected: null },
    });
  });

  it("filtered choices fit the reserved 60x18 editor space without exposing terminal controls", () => {
    const frame = renderFormFrame(view, "branch", true, 60, 18, false);
    const editor = renderInputChoice(
      "Branch",
      { text: "fea", selected: null },
      [
        ...choices,
        {
          value: { path: "/repo/hidden" },
          title: "\x1b[2J feature \u202every-long-branch-name ".repeat(4),
        },
      ],
      60,
      18,
      false,
    );
    expect(
      frame.split("\r\n").length + editor.split("\r\n").length - 1,
    ).toBeLessThanOrEqual(18);
    expect(editor).not.toContain("\x1b");
    expect(editor).not.toContain("\u202e");
    expect(
      editor.split("\r\n").every((line) => Bun.stringWidth(line) <= 60),
    ).toBe(true);
    expect(
      renderInputChoice(
        "Branch",
        { text: "", selected: null },
        choices,
        60,
        12,
        false,
      ).split("\r\n").length,
    ).toBeLessThanOrEqual(4);
  });

  it("the complete editor stays within 60x18 and exact-only selections never commit typed text", () => {
    const parent = renderFormFrame(view, "session", true, 60, 18, false);
    const editor = renderInputChoice(
      "Exact session",
      { text: "", selected: 1 },
      choices,
      60,
      18,
      false,
      true,
    );
    const combined = `${parent}${editor}`.split("\r\n");
    expect(combined).toHaveLength(18);
    expect(combined.every((line) => Bun.stringWidth(line) <= 60)).toBe(true);
    expect(combined.some((line) => line.includes("SESSION"))).toBe(true);
    expect(combined.some((line) => line.includes("┘"))).toBe(true);
    expect(
      advanceInputChoice(
        { text: "custom", selected: null },
        key("enter"),
        choices,
        true,
      ),
    ).toEqual({ _tag: "Beep" });
    expect(
      advanceInputChoice(
        { text: "", selected: 1 },
        key("enter"),
        choices,
        true,
      ),
    ).toEqual({
      _tag: "Submit",
      value: { kind: "selected", value: choices[1]!.value },
    });
    expect(
      advanceInputChoice(
        { text: "", selected: 1 },
        key("escape"),
        choices,
        true,
      ),
    ).toEqual({ _tag: "Submit", value: null });
  });
});
