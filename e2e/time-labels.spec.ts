import { test, expect } from "@playwright/test";
import { ready } from "./controls";

test("timeline labels: equal sections, log rules against a simulated .ttl, plot selection and a copied code", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=quick");
  await page.getByRole("button", { name: "Try it now with simulated data" }).click();
  await ready(page, 60000);

  const button = page.getByRole("button", { name: "Timeline labels", exact: true });
  await button.click();
  const panel = page.getByRole("dialog", { name: "Timeline labels", exact: true });
  // The table's label rows; Total is its last.
  const rows = panel.locator(".time-stats tbody tr:not(.total)");
  const total = panel.locator(".time-stats tr.total");
  // Two sections by default, labelled 0 and 1: half the trial each, one segment apiece.
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText(/^0\s*5:00\s*50\.0%\s*1$/);
  // Four sections, labelled 0-1-0-1: two labels, two segments each.
  const addSection = panel.getByRole("button", { name: "Add section" });
  await addSection.click();
  await addSection.click();
  await expect(panel.getByLabel(/^Section \d+ label$/)).toHaveCount(4);
  // Each section's row shows the times it spans.
  await expect(panel.locator(".time-range")).toHaveText([
    "0:00 – 2:30",
    "2:30 – 5:00",
    "5:00 – 7:30",
    "7:30 – 10:00",
  ]);
  await panel.getByLabel("Section 3 label", { exact: true }).fill("0");
  await panel.getByLabel("Section 4 label", { exact: true }).fill("1");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveText(/^1\s*5:00\s*50\.0%\s*2$/);
  // 0-1-1-1: neighbours with one label join up.
  await panel.getByLabel("Section 3 label", { exact: true }).fill("1");
  await expect(rows.nth(1)).toHaveText(/^1\s*7:30\s*75\.0%\s*1$/);
  // Removing a section shares the trial among the rest.
  await panel.getByRole("button", { name: "Remove section 4" }).click();
  await expect(panel.locator(".time-range")).toHaveText([
    "0:00 – 3:20",
    "3:20 – 6:40",
    "6:40 – 10:00",
  ]);

  // Custom times, each limited by its neighbours: 0 from 0 s and 1 from 300 s by default.
  await panel.getByRole("button", { name: "Custom", exact: true }).click();
  await expect(rows.nth(0)).toHaveText(/^0\s*5:00\s*50\.0%\s*1$/);
  await panel.getByRole("button", { name: "Add time" }).click();
  // Halfway from the last time to the end of the 600 s trial.
  await expect(panel.getByLabel("Time 3", { exact: true })).toHaveValue("450");
  await expect(rows).toHaveCount(3);
  const second = panel.getByLabel("Time 2", { exact: true });
  await second.fill("500");
  await expect(second).toHaveAttribute("aria-invalid", "true");
  await second.blur();
  await expect(second).toHaveValue("300");
  await second.fill("2:00");
  await second.blur();
  await expect(second).toHaveValue("120");
  await expect(rows.nth(1)).toHaveText(/^1\s*5:30\s*55\.0%\s*1$/);
  await panel.getByLabel("Time 3", { exact: true }).fill("900");
  await expect(panel.getByText("after the end")).toBeVisible();
  await panel.getByRole("button", { name: "Remove time 3" }).click();
  await expect(rows).toHaveCount(2);

  // The first simulated trial has a log: the light alternates on TTL 4, 1 on and 0 off.
  await panel.getByRole("button", { name: "Log file" }).click();
  await expect(panel.getByText("demo_box-a.ttl")).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td").first()).toHaveText("0");
  await expect(rows.nth(1).locator("td").first()).toHaveText("1");
  const matched = panel.locator(".time-matched");
  await expect(matched).toHaveCount(2);
  await expect(matched.nth(0)).toHaveText(/^\d+ lines$/);
  // Reward pulses on TTL 2 belong to neither rule; a catch-all after them takes them.
  await panel.getByRole("button", { name: "Add rule" }).click();
  await panel.getByLabel("Rule 3 pattern").fill(String.raw`^ttl_2 (\S+) 1$`);
  // A new rule takes the next label, 2; its steps go up and down.
  await expect(panel.getByLabel("Rule 3 label", { exact: true })).toHaveValue("2");
  await panel.getByRole("button", { name: "Rule 3 label: next" }).click();
  await expect(panel.getByLabel("Rule 3 label", { exact: true })).toHaveValue("3");
  await panel.getByLabel("Rule 3 label", { exact: true }).press("ArrowDown");
  await expect(panel.getByLabel("Rule 3 label", { exact: true })).toHaveValue("2");
  await expect(rows).toHaveCount(3);
  await expect(matched.nth(2)).toHaveText(/^\d+ lines$/);
  // A broken regex is reported in the window.
  await panel.getByLabel("Rule 3 pattern").fill("ttl_2 (");
  await expect(panel.getByRole("alert")).toContainText("Rule 3:");
  await panel.getByRole("button", { name: "Remove rule 3" }).click();
  await expect(rows).toHaveCount(2);

  // The cheat sheet is folded away until asked for.
  const help = panel.locator(".time-cheatsheet");
  await expect(help.locator("table")).toBeHidden();
  await help.locator("summary").click();
  await expect(help.getByRole("link", { name: /Full syntax/ })).toHaveAttribute(
    "href",
    /docs\.rs\/regex-lite/,
  );

  // Any rows can be shown in plots; Total alone (the default) is no labelling.
  await expect(total).toHaveText(/^Total\s*10:00\s*100\.0%\s*\d+$/);
  const show = (name: string) => panel.getByLabel(`Show ${name} in plots`);
  await expect(show("Total")).toBeChecked();
  await expect(show("1")).not.toBeChecked();
  await show("1").check();
  await expect(page.getByRole("button", { name: "Timeline labels (on)" })).toBeVisible();
  await show("Total").uncheck();
  // The last ticked row stays ticked, and isn't shown disabled.
  await expect(show("1")).toBeEnabled();
  await show("1").click();
  await expect(show("1")).toBeChecked();

  // Copied as a one-line code, and restored from notes around it.
  await panel.getByRole("button", { name: "Copy timeline labels" }).click();
  // The write is asynchronous: poll rather than race it.
  const read = () => page.evaluate(() => navigator.clipboard.readText());
  await expect.poll(read).toMatch(/^waveform-labels:v1:\{.*"total":0,"show":\[1\]/);
  const code = await read();
  await panel.getByRole("button", { name: "Reset timeline labels" }).click();
  await expect(panel.getByRole("button", { name: "Equal", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.evaluate((c) => navigator.clipboard.writeText(`Day 3 notes: ${c}`), code);
  await panel.getByRole("button", { name: "Restore timeline labels" }).click();
  await expect(panel.getByRole("button", { name: "Log file" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(show("1")).toBeChecked();
  await expect(show("Total")).not.toBeChecked();

  // The second trial has no log.
  await page.getByRole("button", { name: /^demo_box-b \d+$/ }).click();
  await ready(page, 60000);
  await expect(panel.getByRole("alert")).toHaveText("This trial has no log file.");
  await expect(panel.getByText("No match in demo_box-b")).toBeVisible();
  expect(errors).toEqual([]);
});
