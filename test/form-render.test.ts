import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import type { FormView, InputChoiceState } from "../src/contracts.ts";
import {
  advanceInputChoice,
  renderFormFrame,
  renderInputChoice,
} from "../src/ui.ts";

const view: FormView = {
  rows: [
    { id: "project", label: "Project", value: "atelier" },
    {
      id: "machine",
      label: "Machine",
      value: "Homelab",
      detail: "Host ID: host-remote",
    },
    { id: "destination", label: "Worktree", value: "feature" },
    { id: "branch", label: "Branch", value: "feature" },
    { id: "session", label: "Session", value: "session-123" },
    { id: "mode", label: "Mode", value: "Auto" },
  ],
  submitLabel: "Create worktree & open",
};

describe("static form frame", () => {
  it("anchors borders, fields, and footer across loading, details, errors, and editors", () => {
    const editor = renderInputChoice({ text: "", selected: 0 }, [{ value: "one", title: "One" }], 60, 16, false);
    const states = [
      renderFormFrame({ ...view, notice: "Discovering projects…", submitDisabled: true }, "project", 60, 16, false),
      renderFormFrame(view, "machine", 60, 16, false),
      renderFormFrame({ ...view, error: "Cannot use this destination. Choose another directory." }, "session", 60, 16, false),
      renderFormFrame({ ...view, error: "Cannot use this session" }, "session", 60, 16, false, { editor: { title: "Session", lines: editor } }),
    ].map(frame => frame.split("\r\n"));
    for (const lines of states) {
      expect(lines).toHaveLength(16);
      expect(lines[0]).toMatch(/^┌.*┐$/);
      expect(lines[15]).toMatch(/^└.*┘$/);
      expect(lines[3]).toContain("PROJECT");
      expect(lines[4]).toContain("MACHINE");
      expect(lines[5]).toContain("WORKTREE");
      expect(lines.every(line => Bun.stringWidth(line) <= 60)).toBe(true);
    }
    expect(states[3]![14]).toContain("Esc back");
    expect(states[3]!.join(" ")).toContain("Cannot use this session");
    expect(states[1]!.join(" ")).toContain("Host ID: host-remote");
  });

  it("scrolls long diagnostics and conditional fields inside their fixed viewports", () => {
    const message = "Cannot open " + "details ".repeat(60) + "END OF ERROR";
    const first = renderFormFrame({ ...view, error: message }, "project", 60, 16, false);
    const last = renderFormFrame({ ...view, error: message }, "mode", 60, 16, false, { detailOffset: 999 });
    expect(first).toContain("PgDn");
    expect(last).toContain("END OF ERROR");
    expect(last).toContain("MODE");
    expect(first.split("\r\n")).toHaveLength(16);
    expect(last.split("\r\n")).toHaveLength(16);
  });

  it("keeps the field viewport compact in taller popups without moving the footer", () => {
    const lines = renderFormFrame({ ...view, error: "Diagnostic ".repeat(60) + "END OF ERROR" }, "mode", 80, 24, false).split("\r\n");
    expect(lines).toHaveLength(24);
    expect(lines[7]).toContain("MODE");
    expect(lines[8]).toMatch(/^│ +│$/);
    expect(lines[9]).toMatch(/^├.*┤$/);
    expect(lines.slice(10, 21).join(" ")).toContain("END OF ERROR");
    expect(lines[22]).toContain("Tab next");
    expect(lines[23]).toMatch(/^└.*┘$/);
  });

  it("sanitizes untrusted values, subtitles, errors, and editor headings", () => {
    const malicious = "\x1b[2J\x1b]0;hijack\x07\u202eVISIBLE\nNEXT";
    const frame = renderFormFrame({ ...view, error: malicious, rows: view.rows.map(row => ({ ...row, value: malicious, detail: malicious })) }, "machine", 60, 16, false);
    expect(frame).not.toContain("\x1b");
    expect(frame).not.toContain("\x07");
    expect(frame).not.toContain("\u202e");
    expect(frame).toContain("NEXT");
    const editor = renderInputChoice({ text: "  feature\x1b[2J  draft\u202e  ", selected: null }, [], 60, 16, false);
    expect(editor.join("\n")).toContain("  feature  draft");
    expect(editor.join("\n")).not.toContain("\x1b");
    const editing = renderFormFrame(view, "branch", 60, 16, false, { editor: { title: malicious, lines: editor } });
    expect(editing).not.toContain("\x1b");
    expect(editing.split("\r\n")).toHaveLength(16);
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
    const editor = renderInputChoice({ text: "fea", selected: null }, [
      ...choices,
      {
        value: { path: "/repo/hidden" },
        title: "\x1b[2J feature \u202every-long-branch-name ".repeat(4),
      },
    ], 60, 18, false,);
    const frame = renderFormFrame(view, "branch", 60, 18, false, { editor: { title: "Branch", lines: editor } });
    expect(frame.split("\r\n")).toHaveLength(18);
    expect(editor.join("\n")).not.toContain("\x1b");
    expect(editor.join("\n")).not.toContain("\u202e");
    expect(
      editor.every((line) => Bun.stringWidth(line) <= 60),
    ).toBe(true);
  });

  it("uses the full choice viewport before scrolling and keeps the selected item visible", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ value: index, title: `Choice ${index}` }));
    for (const selected of [0, 19]) {
      const editor = renderInputChoice({ text: "", selected }, items, 80, 24, false);
      const frame = renderFormFrame(view, "project", 80, 24, false, { editor: { title: "Project", lines: editor } }).split("\r\n");
      expect(frame[8]).toMatch(/^│ +│$/);
      expect(frame.slice(11, 21).every(line => line.includes("Choice"))).toBe(true);
      expect(frame.slice(11, 21).join("\n")).toContain(`› Choice ${selected}`);
      expect(frame[22]).toContain("Esc back");
      expect(frame).toHaveLength(24);
    }
  });

  it("the complete editor stays within 60x18 and exact-only selections never commit typed text", () => {
    const editor = renderInputChoice({ text: "", selected: 1 }, choices, 60, 18, false,
    true,);
    const combined = renderFormFrame(view, "session", 60, 18, false, { editor: { title: "Exact session", lines: editor } }).split("\r\n");
    expect(combined.length).toBeLessThanOrEqual(18);
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

it("Ctrl+S commits valid editor content but neither incomplete exact input nor cancel submits", () => {
  const choices = [{ value: "session:one", title: "One" }];
  const key = (name: string, ctrl = false) => ({
    key: { name, ctrl, shift: false, meta: false },
    input: Option.some(""),
  });
  expect(advanceInputChoice({ text: "", selected: 0 }, key("s", true), choices, true))
    .toEqual({ _tag: "Submit", value: { kind: "selected", value: "session:one" } });
  expect(advanceInputChoice({ text: "missing", selected: null }, key("s", true), choices, true))
    .toEqual({ _tag: "Beep" });
  expect(advanceInputChoice({ text: "/target/alpha", selected: null }, key("s", true), choices))
    .toEqual({ _tag: "Submit", value: { kind: "typed", text: "/target/alpha" } });
  expect(advanceInputChoice({ text: "missing", selected: null }, key("escape"), choices))
    .toEqual({ _tag: "Submit", value: null });
});


it("repository-provided JJ revision labels cannot inject terminal controls or new rows", () => {
  const unsafe = "main\u001b]2;hijack\u0007\nnext\u001b[31m";
  const editor = renderInputChoice({ text: "", selected: 0 }, [{ value: "a".repeat(40), title: unsafe, description: "commit\u001b[2J\nsecond" }], 60, 18, false);
  expect(editor.join("\n")).not.toContain("\u001b");
  expect(editor.join("\n")).not.toContain("\u0007");
  expect(editor[1]).toContain("main next · commit second");
  expect(editor.every(line => Bun.stringWidth(line) <= 60)).toBe(true);
});
