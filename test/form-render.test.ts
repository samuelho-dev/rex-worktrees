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
    { id: "checkoutName", label: "Directory", value: "feature-tree" },
    { id: "session", label: "Session", value: "session-123" },
    { id: "mode", label: "Mode", value: "Auto" },
  ],
  submitLabel: "Create worktree & open",
};

describe("static form frame", () => {
  it("keeps every field, dock and button at fixed coordinates across focus and form states", () => {
    const editor = renderInputChoice({ text: "", selected: 0 }, [{ value: "one", title: "One" }], 80, false);
    const ordinary = { ...view, rows: view.rows.filter(row => row.id !== "branch" && row.id !== "checkoutName") };
    const states = [
      renderFormFrame({ ...ordinary, notice: "Discovering projects…", submitDisabled: true }, "project", 80, 16, false),
      renderFormFrame(ordinary, "machine", 80, 16, false),
      renderFormFrame(view, "mode", 80, 16, false),
      renderFormFrame({ ...view, error: "Cannot use this destination" }, "session", 80, 16, false),
      renderFormFrame({ ...view, error: "Cannot use this session" }, "session", 80, 16, false, { editor: { title: "Session", lines: editor } }),
    ].map(frame => frame.split("\r\n"));
    for (const lines of states) {
      expect(lines).toHaveLength(16);
      expect(lines[0]?.trimEnd()).toBe("REX / WORKTREES");
      expect(lines[1]).toMatch(/^─+$/);
      for (const [index, label] of ["PROJECT", "MACHINE", "WORKTREE", "BRANCH", "DIRECTORY", "SESSION", "MODE"].entries())
        expect(lines[index + 2]).toContain(label);
      expect(lines[9]).toContain("─");
      expect(lines.every(line => Bun.stringWidth(line) === 80)).toBe(true);
    }
    expect(states[1]![15]).toContain("Tab next");
    expect(states[4]![15]).toContain("Esc back");
    expect(states[4]![14]).toContain("Cannot use this session");
    expect(states[1]!.join(" ")).toContain("Host ID: host-remote");
    expect(states[1]![6]).toMatch(/DIRECTORY\s+—/);
    expect(states[2]![6]).toContain("feature-tree");
  });

  it("scrolls long details without scrolling any form field", () => {
    const message = "Cannot open " + "details ".repeat(60) + "END OF ERROR";
    const first = renderFormFrame({ ...view, error: message }, "project", 80, 16, false);
    const last = renderFormFrame({ ...view, error: message }, "mode", 80, 16, false, { detailOffset: 999 });
    expect(first).toContain("PgDn");
    expect(last.replace(/\s+/g, " ")).toContain("END OF ERROR");
    for (const frame of [first, last]) {
      expect(frame.split("\r\n")[7]).toContain("SESSION");
      expect(frame.split("\r\n")[8]).toContain("MODE");
      expect(frame.split("\r\n")[15]).toContain("Tab next");
    }
  });

  it("fills the native viewport without adding outer padding or moving field slots", () => {
    const normal = renderFormFrame(view, "mode", 80, 16, false).split("\r\n");
    const larger = renderFormFrame(view, "mode", 82, 18, false).split("\r\n");
    expect(larger).toHaveLength(18);
    expect(larger.every(line => Bun.stringWidth(line) === 82)).toBe(true);
    expect(larger[0]?.trimEnd()).toBe(normal[0]?.trimEnd());
    expect(larger[1]).toMatch(/^─+$/);
    for (let index = 2; index < 9; index++) expect(larger[index]?.trimEnd()).toBe(normal[index]?.trimEnd());
    expect(larger[2]).toContain("PROJECT");
    expect(larger[17]).toContain("Tab next");
  });

  it("sanitizes untrusted values, subtitles, errors, and editor headings", () => {
    const malicious = "\x1b[2J\x1b]0;hijack\x07\u202eVISIBLE\nNEXT";
    const frame = renderFormFrame({ ...view, error: malicious, rows: view.rows.map(row => ({ ...row, value: malicious, detail: malicious })) }, "machine", 60, 20, false);
    expect(frame).not.toContain("\x1b");
    expect(frame).not.toContain("\x07");
    expect(frame).not.toContain("\u202e");
    expect(frame).toContain("NEXT");
    const editor = renderInputChoice({ text: "  feature\x1b[2J  draft\u202e  ", selected: null }, [], 60, false);
    expect(editor.join("\n")).toContain("  feature  draft");
    expect(editor.join("\n")).not.toContain("\x1b");
    const editing = renderFormFrame(view, "branch", 60, 20, false, { editor: { title: malicious, lines: editor } });
    expect(editing).not.toContain("\x1b");
    expect(editing.split("\r\n")).toHaveLength(20);
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

  it("filtered choices fit the reserved editor dock without exposing terminal controls", () => {
    const editor = renderInputChoice({ text: "fea", selected: null }, [
      ...choices,
      {
        value: { path: "/repo/hidden" },
        title: "\x1b[2J feature \u202every-long-branch-name ".repeat(4),
      },
    ], 60, false);
    const frame = renderFormFrame(view, "branch", 60, 20, false, { editor: { title: "Branch", lines: editor } });
    expect(frame.split("\r\n")).toHaveLength(20);
    expect(editor.join("\n")).not.toContain("\x1b");
    expect(editor.join("\n")).not.toContain("\u202e");
    expect(
      editor.every((line) => Bun.stringWidth(line) <= 60),
    ).toBe(true);
  });

  it("uses the full choice viewport before scrolling and keeps the selected item visible", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ value: index, title: `Choice ${index}` }));
    for (const selected of [0, 19]) {
      const editor = renderInputChoice({ text: "", selected }, items, 80, false);
      const frame = renderFormFrame(view, "project", 80, 16, false, { editor: { title: "Project", lines: editor } }).split("\r\n");
      expect(frame[10]).toContain("Type new value");
      expect(frame.slice(11, 14).every(line => line.includes("Choice"))).toBe(true);
      expect(frame.slice(11, 14).join("\n")).toContain(`› Choice ${selected}`);
      expect(frame[15]).toContain("Esc back");
      expect(frame).toHaveLength(16);
    }
  });

  it("the complete editor fits its fixed dock and exact-only selections never commit typed text", () => {
    const editor = renderInputChoice({ text: "", selected: 1 }, choices, 60, false, true);
    const combined = renderFormFrame(view, "session", 60, 20, false, { editor: { title: "Exact session", lines: editor } }).split("\r\n");
    expect(combined).toHaveLength(20);
    expect(combined.every((line) => Bun.stringWidth(line) <= 60)).toBe(true);
    expect(combined.some((line) => line.includes("SESSION"))).toBe(true);
    expect(combined.at(-1)).toContain("Esc back");
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
  const editor = renderInputChoice({ text: "", selected: 0 }, [{ value: "a".repeat(40), title: unsafe, description: "commit\u001b[2J\nsecond" }], 60, false);
  expect(editor.join("\n")).not.toContain("\u001b");
  expect(editor.join("\n")).not.toContain("\u0007");
  expect(editor[1]).toContain("main next · commit second");
  expect(editor.every(line => Bun.stringWidth(line) <= 60)).toBe(true);
});
