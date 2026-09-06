import { test, expect } from "@playwright/test";
import { workspaceFixture } from "../workspace-fixture.js";
import type { ExchangeState } from "../../src/protocol/types.js";
import { repository } from "../project-fixture.js";
import { rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { Satellite } from "../../src/satellite.js";
import { channels } from "../../src/protocol/types.js";
import { signObject } from "../../src/hash.js";
import { reviewManifest } from "../../src/review.js";
import { verifyCheckpoint } from "../../src/verification.js";
import { AxeBuilder } from "@axe-core/playwright";

test("a contributor can inspect a host checkpoint, discuss a file and retain attribution after reload", async ({
  page,
}) => {
  const f = await workspaceFixture();
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(await f.open("contributor"));
    await expect(
      page.getByRole("heading", { name: "Project overview" }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/access=/);
    await expect(
      page.getByRole("button", { name: "New contribution" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: "test-results/workspace-overview.png",
      fullPage: true,
    });
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      accessibility.violations.map((v) => ({
        id: v.id,
        description: v.description,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ).toEqual([]);
    await page.getByRole("button", { name: /Explain parser errors/ }).click();
    await expect(
      page.getByRole("tab", { name: "Changes", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByText("Add a value before parsing.", { exact: false }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/workspace-diff.png",
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
    ).toEqual([]);
    await page.getByRole("button", { name: "Use split diff" }).click();
    await page.getByRole("button", { name: "Use unified diff" }).click();
    await page.getByLabel("Search changed files").fill("README");
    await page.getByRole("treeitem", { name: "README.md" }).click();
    await expect(
      page.getByText("Empty input produces a clear, actionable error.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("Search changed files").fill("");
    await page.getByRole("treeitem", { name: "parser.ts" }).click();
    await page.getByRole("button", { name: "Discuss this file" }).click();
    await page
      .getByLabel("Join the discussion")
      .fill("The error is much clearer. Let's keep the public API stable.");
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(
      page.getByText(
        "The error is much clearer. Let's keep the public API stable.",
      ),
    ).toBeVisible();
    const state = await f.maintainer.snapshot<ExchangeState>(
      "axp-session:/parser-errors",
    );
    expect(state.discussion?.at(-1)?.author).toBe("contributor");
    expect(state.discussion?.at(-1)?.path).toBe("src/parser.ts");
    await page.reload();
    await page.getByRole("tab", { name: /Discussion/ }).click();
    await expect(
      page.getByText(
        "The error is much clearer. Let's keep the public API stable.",
      ),
    ).toBeVisible();
    await page.getByRole("tab", { name: /Discussion/ }).press("Home");
    await expect(
      page.getByRole("tab", { name: "Agent session" }),
    ).toBeFocused();
    await expect(page.getByLabel("Message the agent")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("browser permission drives a real ACP edit, exact Git verification and an independent artifact approval", async ({
  page,
}) => {
  const f = await workspaceFixture();
  const repo = await repository();
  const c = channels("real-addition");
  const maintainerKey = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const contributorKey = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  let satellite: Satellite | undefined;
  try {
    await f.maintainer.ahp.request("createSession", {
      channel: c.session,
      provider: "axp",
      config: { title: "Fix actual addition", task: "real-browser-edit" },
    });
    satellite = new Satellite({
      url: f.url,
      token: f.credentials[1]!.token,
      session: c.exchange,
      repository: repo,
      agent: {
        command: process.execPath,
        args: [
          "--import",
          pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
          resolve("examples/fixture-agent.ts"),
        ],
        isolation: "native",
      },
      allowance: { tokens: 10000, costMicros: 0, turns: 5 },
      perTurn: { tokens: 2000, costMicros: 0, turns: 1 },
    });
    await satellite.start();
    await page.goto(await f.open("maintainer", maintainerKey));
    await page.getByRole("button", { name: /Fix actual addition/ }).click();
    await page
      .getByLabel("Message the agent")
      .fill("Fix the addition bug in sum.js and run node --test.");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect
      .poll(
        async () =>
          !!(await f.maintainer.snapshot<ExchangeState>(c.exchange)).checkpoint,
      )
      .toBe(true);
    const state = await f.maintainer.snapshot<ExchangeState>(c.exchange);
    await page.getByRole("tab", { name: "Agent session", exact: true }).click();
    await page
      .getByText("Fix addition and run node --test", { exact: true })
      .click();
    await expect(page.locator(".tool-result")).toContainText("pass 1");

    expect(await readFile(join(repo, "sum.js"), "utf8")).toContain("a - b");
    expect(
      (
        await verifyCheckpoint(f.verifier, c.exchange, repo, [
          process.execPath,
          "--test",
        ])
      ).exitCode,
    ).toBe(0);
    const contributorPage = await page.context().newPage();
    await contributorPage.goto(await f.open("contributor", contributorKey));
    await contributorPage
      .getByRole("button", { name: /Fix actual addition/ })
      .click();
    await contributorPage
      .getByRole("button", { name: "Submit for review", exact: true })
      .click();
    await contributorPage
      .getByLabel("Agent or model used")
      .fill("deterministic-acp-fixture");
    await contributorPage
      .getByRole("button", { name: "Sign and submit", exact: true })
      .click();
    await expect(contributorPage.getByRole("dialog")).toHaveCount(0);
    await contributorPage.close();
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await expect(
      page.getByText("Independent checks passed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("export const sum = (a, b) => a + b;", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Approve artifact", exact: true })
      .click();
    // A newer manifest arriving while the dialog is open must not replace what was approved.
    const revised = await reviewManifest(
      f.contributor,
      state,
      "corrected-fixture-model-description",
    );
    await f.contributor.call("_axp/review", {
      channel: c.exchange,
      manifest: revised,
      contributor: signObject(revised, contributorKey),
    });
    await page
      .getByLabel("I reviewed these changes and want to sign this artifact.")
      .check();
    await page
      .getByRole("button", { name: "Sign approval", exact: true })
      .click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "Artifact changed",
    );
    expect(
      (await f.maintainer.snapshot<ExchangeState>(c.exchange)).review
        ?.maintainer,
    ).toBeNull();
    await page
      .getByRole("button", { name: "Keep reviewing", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Approve artifact", exact: true })
      .click();
    await page
      .getByLabel("I reviewed these changes and want to sign this artifact.")
      .check();
    await page
      .getByRole("button", { name: "Sign approval", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      (await f.maintainer.snapshot<ExchangeState>(c.exchange)).review
        ?.maintainer,
    ).not.toBeNull();
  } finally {
    await satellite?.stop();
    await f.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test("maintainer creation, permission controls and reconnect converge with host state on desktop and phone", async ({
  page,
  context,
}) => {
  const f = await workspaceFixture();
  try {
    await page.goto(await f.open());
    await page.getByRole("button", { name: "New contribution" }).click();
    await page
      .getByLabel("What do you want to work on?")
      .fill("Make contributing easier");
    await page.getByLabel("Task or issue reference").fill("issue-browser");
    await page.getByRole("button", { name: "Create contribution" }).click();
    await expect(
      page.getByRole("heading", { name: "Make contributing easier" }),
    ).toBeVisible();
    await page
      .getByLabel("Message the agent")
      .fill("Start with the first-run documentation.");
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(
      page.getByText("Start with the first-run documentation.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "All contributions", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Improve first-time setup/ })
      .click();
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Allow once", exact: true }),
    ).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByRole("alert")).toContainText(
      "Showing the last update we received",
    );
    await context.setOffline(false);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "All contributions", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Contributions", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "People", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "Contributions", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/workspace-phone.png",
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});

test("a missing deep link leaves the workspace usable and an agent failure explains itself", async ({
  page,
}) => {
  const f = await workspaceFixture();
  try {
    const link = new URL(await f.open());
    link.search = "?session=does-not-exist";
    await page.goto(link.href);
    await expect(
      page.getByRole("heading", {
        name: "This contribution could not be opened",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Opening contribution…", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "All contributions", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Handle email task retries/ })
      .click();
    const state = await f.contributor.snapshot<ExchangeState>(
      "axp-session:/mail-bridge",
    );
    await f.contributor.call("_axp/settle", {
      channel: state.resource,
      epoch: state.epoch,
      turnId: "demo-2",
      usage: null,
      outcome: "error",
      error: "Agent stopped: the build command was not found.",
    });
    await expect(page.getByRole("alert")).toContainText(
      "Agent stopped: the build command was not found.",
    );
    await expect(
      page.getByText("Needs attention", { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test("a file discussion draft and its checkpoint reference survive reload without posting automatically", async ({
  page,
}) => {
  const f = await workspaceFixture();
  try {
    await page.goto(await f.open("contributor"));
    await page.getByRole("button", { name: /Explain parser errors/ }).click();
    await page.getByRole("button", { name: "Discuss this file" }).click();
    await page
      .getByLabel("Join the discussion")
      .fill("A draft attached to this exact file.");
    const before = (
      await f.contributor.snapshot<ExchangeState>("axp-session:/parser-errors")
    ).discussion!.length;
    await page.reload();
    await page.getByRole("tab", { name: /Discussion/ }).click();
    await expect(page.getByLabel("Join the discussion")).toHaveValue(
      "A draft attached to this exact file.",
    );
    await expect(page.locator(".comment-form .comment-anchor")).toContainText(
      "src/parser.ts",
    );
    expect(
      (
        await f.contributor.snapshot<ExchangeState>(
          "axp-session:/parser-errors",
        )
      ).discussion,
    ).toHaveLength(before);
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByLabel("Join the discussion")).toHaveValue("");
    expect(
      (
        await f.contributor.snapshot<ExchangeState>(
          "axp-session:/parser-errors",
        )
      ).discussion!.at(-1)?.path,
    ).toBe("src/parser.ts");
  } finally {
    await f.close();
  }
});

test("older contributions are reachable through pages and project-wide title search", async ({
  page,
}) => {
  const f = await workspaceFixture();
  try {
    await f.maintainer.ahp.request("createSession", {
      channel: "ahp-session:/old-search-target",
      config: { title: "An older searchable contribution" },
    });
    for (let i = 0; i < 42; i++)
      await f.maintainer.ahp.request("createSession", {
        channel: `ahp-session:/recent-${i}`,
        config: { title: `Recent work ${i}` },
      });
    await page.goto(await f.open());
    await expect(
      page.getByRole("button", { name: /An older searchable contribution/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(
      page.getByRole("button", { name: /An older searchable contribution/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Previous page" }).click();
    await expect(
      page.getByRole("button", { name: /An older searchable contribution/ }),
    ).toHaveCount(0);
    await page.getByLabel("Search contributions").fill("older searchable");
    await expect(
      page.getByRole("button", { name: /An older searchable contribution/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(
      0,
    );
    await page
      .getByRole("button", { name: /An older searchable contribution/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "An older searchable contribution" }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test("stored agent content is inspectable and downloadable without executing its HTML", async ({
  page,
}) => {
  const f = await workspaceFixture();
  try {
    const state = await f.contributor.snapshot<ExchangeState>(
      "axp-session:/mail-bridge",
    );
    const text =
      '<script>document.title="attachment executed"</script>\nA retained tool result.';
    const blob = await f.contributor.call("_axp/blobPut", {
      channel: state.resource,
      data: Buffer.from(text).toString("base64"),
      mediaType: "text/plain",
    });
    await f.contributor.call("_axp/emit", {
      channel: state.resource,
      epoch: state.epoch,
      actions: [
        {
          type: "chat/responsePart",
          turnId: "demo-2",
          part: {
            kind: "contentRef",
            uri: blob.uri,
            contentType: blob.mediaType,
            sizeHint: blob.size,
          },
        },
      ],
    });
    await page.goto(await f.open("observer"));
    await page
      .getByRole("button", { name: /Handle email task retries/ })
      .click();
    await page
      .getByRole("button", { name: "View content", exact: true })
      .click();
    await expect(page.locator(".stored-content pre")).toHaveText(text);
    await expect(page).not.toHaveTitle("attachment executed");
    const saved = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download content", exact: true })
      .click();
    const download = await saved;
    expect(await readFile((await download.path())!, "utf8")).toBe(text);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
