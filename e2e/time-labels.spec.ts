import { test, expect } from "@playwright/test";
import { readClipboard, ready } from "./controls";

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

  // The toolbar's toggle shows the timeline pane and opens its window.
  const button = page.getByRole("button", { name: "Timeline labels", exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const pane = page.getByRole("region", { name: "Timeline labels" });
  const panel = page.getByRole("dialog", { name: "Timeline labels", exact: true });
  // The table's label rows; Total is its last.
  const rows = pane.locator(".time-stats tbody tr:not(.total)");
  const total = pane.locator(".time-stats tr.total");
  const summary = pane.locator(".timeline-summary span");
  const cog = pane.getByRole("button", { name: "Timeline label settings" });
  await expect(summary).toHaveText("2 equal sections");
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
  await expect(panel.locator(".time-file-status.found")).toHaveText("demo_box-a.ttl");
  // A glob matching none (or several) is an error, and no file is read.
  await panel.getByLabel("Log file", { exact: true }).fill("*.log");
  await expect(panel.getByRole("alert")).toHaveText("No file of demo_box-a matches");
  await expect(summary).toHaveText("2 rules on no log file");
  await panel.getByLabel("Log file", { exact: true }).fill("*.ttl");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td").first()).toHaveText("0");
  await expect(rows.nth(1).locator("td").first()).toHaveText("1");
  const matched = panel.locator(".time-matched");
  await expect(matched).toHaveCount(2);
  await expect(matched.nth(0)).toHaveText(/^matched \d+\/\d+ lines$/);
  // A valid rule that matches is green, with a check.
  await expect(matched.nth(0)).toHaveClass(/found/);
  await expect(matched.nth(0).getByLabel("Valid")).toBeVisible();
  // Reward pulses on TTL 2 belong to neither rule; a catch-all after them takes them.
  await panel.getByRole("button", { name: "Add rule" }).click();
  // The new rule's pattern takes the focus.
  await expect(panel.getByLabel("Rule 3 pattern")).toBeFocused();
  // Without a capture group, its lines still preview (in its label's colour), with the error
  // in the pane.
  await panel.getByLabel("Rule 3 pattern").fill("^ttl_2 .* 1$");
  const preview = panel.getByRole("list", { name: "Log preview" });
  await expect(preview.locator("li.match", { hasText: "ttl_2" }).first()).toBeVisible();
  await expect(pane.getByRole("alert")).toContainText("needs a capture group");
  // Its row says both: what it matched, and that it has no time group.
  await expect(matched.nth(2)).toHaveText(/^matched \d+\/\d+ lines, no time group$/);
  // With no time, its unit doesn't apply.
  await expect(panel.getByLabel("Rule 3 time unit")).toBeDisabled();
  // Several groups, none named the time: which is meant isn't known.
  await panel.getByLabel("Rule 3 pattern").fill(String.raw`(ttl)_2 (\S+) 1`);
  await expect(matched.nth(2)).toHaveText(/^2 capture groups: make the others \(\?:…\)/);
  await expect(panel.getByLabel("Rule 3 time unit")).toBeDisabled();
  await panel.getByLabel("Rule 3 pattern").fill(String.raw`(?:ttl)_2 (\S+) 1`);
  await expect(matched.nth(2)).toHaveClass(/found/);
  await expect(panel.getByLabel("Rule 1 time unit")).toBeEnabled();
  await panel.getByLabel("Rule 3 pattern").fill(String.raw`^ttl_2 (\S+) 1$`);
  // A new rule takes the next label, 2; its steps go up and down.
  await expect(panel.getByLabel("Rule 3 label", { exact: true })).toHaveValue("2");
  await panel.getByRole("button", { name: "Rule 3 label: next" }).click();
  await expect(panel.getByLabel("Rule 3 label", { exact: true })).toHaveValue("3");
  await panel.getByLabel("Rule 3 label", { exact: true }).press("ArrowDown");
  await expect(panel.getByLabel("Rule 3 label", { exact: true })).toHaveValue("2");
  await expect(rows).toHaveCount(3);
  await expect(matched.nth(2)).toHaveText(/^matched \d+\/\d+ lines$/);
  // A broken regex is reported in the window.
  await panel.getByLabel("Rule 3 pattern").fill("ttl_2 (");
  await expect(pane.getByRole("alert")).toContainText("Rule 3:");
  // Its row shows the error, not a count.
  await expect(matched.nth(2)).toHaveText(/unclosed|open group|closing/i);
  // The other rules still label, and the broken one is marked.
  await expect(total).toBeVisible();
  await expect(panel.getByLabel("Rule 3 pattern")).toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByLabel("Rule 1 pattern")).toHaveAttribute("aria-invalid", "false");
  await panel.getByRole("button", { name: "Remove rule 3" }).click();
  await expect(rows).toHaveCount(2);

  // The window's foot previews the log: each label's first two and last lines, in its colour
  // with the time picked out, "…" where lines are skipped; then a cheat sheet.
  const shown = preview.locator("li.match");
  // Label 1 has three lines and 0 two: all are shown.
  await expect(shown).toHaveCount(5);
  await expect(shown.first()).toContainText(/ttl_4 [\d.]+ 1/);
  await expect(shown.first().locator("mark")).toHaveText(/^[\d.]+$/);
  await expect(preview.locator("li.gap").first()).toHaveText("…");
  await expect(panel.getByRole("link", { name: /Full syntax/ })).toHaveAttribute(
    "href",
    /docs\.rs\/regex-lite/,
  );
  // With no rule that matches, the file's first and last lines.
  await panel.getByLabel("Rule 1 pattern").fill("nothing (here)");
  await panel.getByLabel("Rule 2 pattern").fill("nor (here)");
  await expect(shown).toHaveCount(0);
  await expect(preview.locator("li.other")).toHaveCount(4);
  await expect(preview.locator("li.other").first()).toContainText("ttl_");
  await panel.getByLabel("Rule 1 pattern").fill(String.raw`ttl_4 (\S+) 1`);
  await panel.getByLabel("Rule 2 pattern").fill(String.raw`ttl_4 (\S+) 0`);
  await expect(shown).toHaveCount(5);
  // Times that aren't numbers, or run outside the trial (beyond 10 s either side), are
  // flagged; the labels are still made.
  await panel.getByLabel("Rule 1 pattern").fill(String.raw`(ttl)_4 \S+ 1`);
  await expect(matched.nth(0)).toHaveText(/3 times aren't numbers/);
  await panel.getByLabel("Rule 1 pattern").fill(String.raw`ttl_4 \d+\.(\d+) 1`);
  await expect(matched.nth(0)).toHaveText(/outside the trial/);
  await expect(pane.getByRole("alert")).toContainText("outside the trial (0 to 600 s)");
  await expect(total).toBeVisible();
  await panel.getByLabel("Rule 1 pattern").fill(String.raw`ttl_4 (\S+) 1`);
  await expect(matched.nth(0)).toHaveClass(/found/);

  // Any rows can be shown in plots; Total alone (the default) is no labelling.
  await expect(total).toHaveText(/^Total\s*10:00\s*100\.0%\s*\d+$/);
  const show = (name: string) => pane.getByLabel(`Show ${name} in plots`);
  await expect(show("Total")).toBeChecked();
  await expect(show("1")).not.toBeChecked();
  await show("1").check();
  // Tiles add a rate map for label 1, marked with the timeline icon in its colour.
  const firstTile = page.locator(".cell-tile").first();
  const labelMap = firstTile.locator(".tile-label-spatial");
  await expect(labelMap).toHaveCount(1);
  await expect(labelMap.locator(".label-mark")).toHaveText("1");
  await expect(labelMap.locator("canvas")).toBeVisible({ timeout: 30000 });
  await expect(firstTile.locator(".tile-spatial:not(.tile-label-spatial)")).toHaveCount(1);
  // Hovering label 1's row shows its times on the path above, marked; leaving, the whole path.
  const pathMark = page.locator(".position-label-mark");
  await rows.nth(1).hover();
  await expect(pathMark).toHaveText("1");
  await page.mouse.move(700, 10);
  await expect(pathMark).toHaveCount(0);
  // Ctrl+C copies the cell with its label 1 map too, though focus is on a tick box.
  await expect(show("1")).toBeFocused();
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await firstTile.hover();
  await page.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(async () => (await readClipboard(page)).text)
    .toMatch(/spa max: [\d.]+ Hz · spa max L1: [\d.]+ Hz/);
  // In the HTML, label 1's peak shows its mark as a tiny image, not in the map's.
  expect((await readClipboard(page)).html).toContain('alt="L1"');
  await show("Total").uncheck();
  // Without the total, tiles show only label 1's map.
  await expect(firstTile.locator(".tile-spatial:not(.tile-label-spatial)")).toHaveCount(0);
  await expect(labelMap).toHaveCount(1);
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
  await expect(panel.getByRole("alert")).toHaveText("No file of demo_box-b matches");
  await expect(summary).toHaveText("2 rules on no log file");

  // Closing the window leaves the pane; its cog opens the window again.
  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(pane).toBeVisible();
  await expect(cog).toHaveAttribute("aria-pressed", "false");
  await cog.click();
  await expect(panel).toBeVisible();
  await expect(cog).toHaveAttribute("aria-pressed", "true");
  // It toggles the window: pressed again, it closes it.
  await cog.click();
  await expect(panel).toHaveCount(0);
  await cog.click();
  await expect(panel).toBeVisible();
  // The toggle hides both.
  await button.click();
  await expect(pane).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  // Off, the tiles show the whole trial's rate map alone again.
  await expect(page.locator(".tile-label-spatial")).toHaveCount(0);
  await expect(page.locator(".cell-tile").first().locator(".tile-spatial")).toHaveCount(1);
  expect(errors).toEqual([]);
});
