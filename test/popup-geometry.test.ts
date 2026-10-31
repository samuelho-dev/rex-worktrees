import { expect, it } from "@effect/vitest";
import { fitPopupBounds } from "../src/rex.ts";
import type { PopupBounds } from "../src/contracts.ts";

it("popup fit uses its own observed terminal, never a narrow source pane", () => {
  const original: PopupBounds = [0.06, 0.075, 0.88, 0.85];
  const fit = fitPopupBounds(
    original,
    { columns: 96, rows: 16 },
    { columns: 136, rows: 54 },
  )!;
  expect(fit[2]).toBeLessThan(original[2]); // a 44-column source pane previously enlarged this 136-column popup
  expect(fit[3]).toBeLessThan(original[3] / 2);
  expect(
    fitPopupBounds(fit, { columns: 96, rows: 16 }, { columns: 97, rows: 17 }),
  ).toBeUndefined();
  const undershot = fitPopupBounds(
    fit,
    { columns: 96, rows: 16 },
    { columns: 95, rows: 15 },
  )!;
  expect(undershot[2]).toBeGreaterThan(fit[2]);
  expect(undershot[3]).toBeGreaterThan(fit[3]);
});

it("large app windows can shrink well below a fixed fraction, then refit changing form heights", () => {
  const initial: PopupBounds = [0.16, 0.3, 0.68, 0.4];
  const compact = fitPopupBounds(
    initial,
    { columns: 96, rows: 16 },
    { columns: 350, rows: 76 },
  )!;
  expect(compact[2]).toBeLessThan(0.25);
  expect(compact[3]).toBeLessThan(0.18);
  expect(
    fitPopupBounds(
      compact,
      { columns: 96, rows: 16 },
      { columns: 97, rows: 17 },
    ),
  ).toBeUndefined();
  const editor = fitPopupBounds(
    compact,
    { columns: 96, rows: 28 },
    { columns: 97, rows: 17 },
  )!;
  expect(editor[3]).toBeGreaterThan(compact[3]);
  const form = fitPopupBounds(
    editor,
    { columns: 96, rows: 16 },
    { columns: 97, rows: 29 },
  )!;
  expect(form[3]).toBeLessThan(editor[3]);
});

it("preferred 96 columns do not force an impossible resize on a narrow app window", () => {
  const atWindowLimit: PopupBounds = [0.04, 0.06, 0.92, 0.88];
  const fit = fitPopupBounds(
    atWindowLimit,
    { columns: 96, rows: 16 },
    { columns: 60, rows: 18 },
  )!;
  expect(fit[2]).toBe(atWindowLimit[2]); // width cap cannot suppress independent height fitting
  expect(fit[3]).toBeLessThan(atWindowLimit[3]);
});

it("popup fit clamps oversize requests to centered valid window bounds", () => {
  const fit = fitPopupBounds(
    [0.2, 0.2, 0.6, 0.6],
    { columns: 300, rows: 200 },
    { columns: 40, rows: 10 },
  )!;
  expect(fit[2]).toBe(0.92);
  expect(fit[3]).toBe(0.88);
  expect(fit[0] + fit[2]).toBeLessThanOrEqual(1);
  expect(fit[1] + fit[3]).toBeLessThanOrEqual(1);
  expect(
    fitPopupBounds(fit, { columns: 300, rows: 200 }, { columns: 40, rows: 10 }),
  ).toBeUndefined();
});
