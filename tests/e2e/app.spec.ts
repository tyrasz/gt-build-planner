import { expect, test } from "@playwright/test";
import type { BuildPlanResponse } from "../../src/shared/schemas";

test("generates a plan and gates writes behind confirmation", async ({ page }) => {
  let wishlistPayload: unknown;
  let basePlanPayload: unknown;

  await page.route("**/api/session/keys", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, session: { id: "test", createdAt: "2026-05-20T00:00:00.000Z" } })
    });
  });

  await page.route("**/api/agent/build-plan", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockPlan())
    });
  });

  await page.route("**/api/agent/wishlist", async (route) => {
    wishlistPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: wishlistPayload && (wishlistPayload as { confirmed?: boolean }).confirmed ? "created" : "manual_only",
        title: "GT Agent - Stage Steel production",
        writeAttempted: Boolean((wishlistPayload as { confirmed?: boolean }).confirmed),
        message: (wishlistPayload as { confirmed?: boolean }).confirmed
          ? "Wishlist was created in Galactic Tycoons."
          : "Wishlist write needs explicit confirmation.",
        manifest: (wishlistPayload as { manifest: unknown }).manifest,
        warnings: []
      })
    });
  });

  await page.route("**/api/agent/base-plan", async (route) => {
    basePlanPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "manual_only",
        planId: 501,
        writeAttempted: Boolean((basePlanPayload as { confirmed?: boolean }).confirmed),
        message: "Base-plan write needs explicit confirmation.",
        draft: (basePlanPayload as { draft: unknown }).draft,
        warnings: []
      })
    });
  });

  await page.goto("/");
  await page.getByLabel("Galactic Tycoons API key").fill("gt-test-key");
  await page.getByRole("button", { name: "Generate plan" }).click();

  await expect(page.getByRole("heading", { name: "Stage Steel production" })).toBeVisible();
  await expect(page.getByText("Iron Ore")).toBeVisible();

  let basePlanPanel = page.locator(".write-panel").filter({ hasText: "Base Plan" });
  await basePlanPanel.getByRole("checkbox", { name: "Confirm" }).check();
  await expect(basePlanPanel.getByRole("button", { name: "Write" })).toBeEnabled();
  await page.locator(".candidate-list").getByText("Audit saved base plan").click();
  await expect(page.getByRole("heading", { name: "Audit saved base plan" })).toBeVisible();
  basePlanPanel = page.locator(".write-panel").filter({ hasText: "Base Plan" });
  await expect(basePlanPanel.getByRole("checkbox", { name: "Confirm" })).not.toBeChecked();
  await expect(basePlanPanel.getByRole("button", { name: "Write" })).toBeDisabled();
  await page.locator(".candidate-list").getByText("Stage Steel production").click();

  const wishlistPanel = page.locator(".write-panel").filter({ hasText: "Wishlist" });
  await expect(wishlistPanel.getByRole("button", { name: "Write" })).toBeDisabled();
  await wishlistPanel.getByRole("button", { name: "Preview" }).click();
  expect((wishlistPayload as { confirmed: boolean }).confirmed).toBe(false);
  await expect(page.getByText("Wishlist write needs explicit confirmation.")).toBeVisible();

  await wishlistPanel.getByRole("checkbox", { name: "Confirm" }).check();
  await wishlistPanel.getByRole("button", { name: "Write" }).click();
  expect((wishlistPayload as { confirmed: boolean }).confirmed).toBe(true);
  await expect(page.getByText("Wishlist was created in Galactic Tycoons.")).toBeVisible();

  basePlanPanel = page.locator(".write-panel").filter({ hasText: "Base Plan" });
  await expect(basePlanPanel.getByRole("button", { name: "Write" })).toBeDisabled();
});

function mockPlan(): BuildPlanResponse {
  return {
    generatedAt: "2026-05-20T00:00:00.000Z",
    objective: "infer",
    company: { id: 7, name: "Test Combine", cash: 5_000_000, value: 25_000_000, prestige: 140 },
    selectedCandidate: candidate(),
    candidates: [candidate(), secondCandidate()],
    preparedCommands: [],
    warnings: ["Verify in-game before spending cash."],
    rateLimits: []
  };
}

function secondCandidate(): BuildPlanResponse["selectedCandidate"] {
  return {
    id: "base-plan-501",
    title: "Audit saved base plan",
    kind: "base_plan",
    target: {
      baseId: 101,
      baseName: "Foundry",
      planetId: 501
    },
    summary: "Review an existing base plan before spending.",
    score: 72,
    scoreBreakdown: {
      impact: 30,
      costFit: 14,
      inventoryCoverage: 8,
      marketAvailability: 12,
      constraints: 0,
      objectiveFit: 8
    },
    estimatedCost: 20_000,
    cashAfter: 4_980_000,
    confidence: "medium",
    requirements: [],
    blockers: [],
    warnings: [],
    rationale: ["Saved base plan exists."],
    basePlanDraft: {
      id: 501,
      title: "Saved plan",
      exp: 1,
      slots: [{ id: 1, status: 1, buildingType: 20, level: 1 }]
    }
  };
}

function candidate(): BuildPlanResponse["selectedCandidate"] {
  return {
    id: "production-900",
    title: "Stage Steel production",
    kind: "production_chain",
    target: {
      baseId: 101,
      baseName: "Foundry",
      planetId: 501,
      buildingType: 10,
      buildingName: "Smelter",
      recipeId: 900,
      outputMatId: 35,
      outputMatName: "Steel"
    },
    summary: "Prepare Steel with current input and output prices.",
    score: 88,
    scoreBreakdown: {
      impact: 38,
      costFit: 20,
      inventoryCoverage: 10,
      marketAvailability: 15,
      constraints: 0,
      objectiveFit: 5
    },
    estimatedCost: 40_000,
    cashAfter: 4_960_000,
    confidence: "high",
    requirements: [
      {
        matId: 1,
        matName: "Iron Ore",
        requiredQty: 100,
        ownedQty: 0,
        deficitQty: 100,
        tonnes: 100,
        estimatedCost: 100_000,
        unitPrice: 1000,
        priceSource: "market"
      }
    ],
    blockers: [],
    warnings: [],
    rationale: ["Estimated batch margin is positive."],
    wishlistManifest: {
      title: "GT Agent - Stage Steel production",
      materials: [
        {
          matId: 1,
          matName: "Iron Ore",
          requiredQty: 100,
          ownedQty: 0,
          deficitQty: 100,
          tonnes: 100,
          estimatedCost: 100_000,
          unitPrice: 1000,
          priceSource: "market"
        }
      ],
      sourceCandidateId: "production-900"
    },
    basePlanDraft: {
      id: 501,
      title: "Steel line",
      exp: 1,
      slots: [{ id: 1, status: 1, buildingType: 10, level: 1 }]
    }
  };
}
