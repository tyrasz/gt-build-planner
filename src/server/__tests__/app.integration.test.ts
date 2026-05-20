import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../index.js";
import { GtApiError, GalacticTycoonsClient } from "../gtClient.js";
import type { AgentSession } from "../sessionStore.js";
import type { BasePlanDraft, GameSnapshot, WishlistManifest } from "../../shared/schemas.js";
import { mockSnapshot } from "./fixtures.js";

describe("createApp", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("requires a session before planning", async () => {
    app = await createApp({ gtClient: mockClient({ getSnapshot: vi.fn() }) });
    const response = await app.inject({ method: "POST", url: "/api/agent/build-plan", payload: {} });

    expect(response.statusCode).toBe(401);
  });

  it("generates a plan after a key is stored in memory", async () => {
    const getSnapshot = vi.fn(async () => mockSnapshot());
    app = await createApp({ gtClient: mockClient({ getSnapshot }) });

    const session = await app.inject({
      method: "POST",
      url: "/api/session/keys",
      payload: { gtApiKey: "gt-test-key" }
    });
    const cookie = session.headers["set-cookie"];
    const plan = await app.inject({
      method: "POST",
      url: "/api/agent/build-plan",
      headers: { cookie: Array.isArray(cookie) ? cookie[0] : String(cookie) },
      payload: { objective: "infer" }
    });

    expect(plan.statusCode).toBe(200);
    expect(plan.json().selectedCandidate.title).toMatch(/Relieve storage pressure|Stage Steel production/);
    expect(plan.json().candidates.some((candidate: { kind: string }) => candidate.kind === "production_chain")).toBe(true);
    expect(getSnapshot).toHaveBeenCalledOnce();
  });

  it("prevents wishlist writes without explicit confirmation", async () => {
    const writeWishlist = vi.fn();
    app = await createApp({ gtClient: mockClient({ getSnapshot: vi.fn(), writeWishlist }) });
    const cookie = await sessionCookie(app);
    const manifest: WishlistManifest = {
      title: "GT Agent - test",
      materials: [{
        matId: 1,
        matName: "Iron Ore",
        requiredQty: 10,
        ownedQty: 0,
        deficitQty: 10,
        estimatedCost: 100,
        unitPrice: 10,
        priceSource: "market"
      }]
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/wishlist",
      headers: { cookie },
      payload: { manifest, confirmed: false }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "manual_only", writeAttempted: false });
    expect(writeWishlist).not.toHaveBeenCalled();
  });

  it("falls back to a manual base-plan draft when the GT endpoint rejects confirmed writes", async () => {
    const writeBasePlan = vi.fn(async () => {
      throw new GtApiError("not found", "/public/company/baseplan", 404);
    });
    app = await createApp({ gtClient: mockClient({ getSnapshot: vi.fn(), writeBasePlan }) });
    const cookie = await sessionCookie(app);
    const draft: BasePlanDraft = {
      id: 501,
      title: "Smelter line",
      exp: 1,
      slots: [{ id: 1, status: 1, buildingType: 10, level: 2 }]
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/base-plan",
      headers: { cookie },
      payload: { draft, confirmed: true }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "manual_only", writeAttempted: true });
    expect(writeBasePlan).toHaveBeenCalledOnce();
  });
});

async function sessionCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/session/keys",
    payload: { gtApiKey: "gt-test-key" }
  });
  const cookie = response.headers["set-cookie"];
  return Array.isArray(cookie) ? cookie[0] : String(cookie);
}

function mockClient(overrides: Partial<{
  getSnapshot: (session: AgentSession) => Promise<GameSnapshot>;
  writeWishlist: (session: AgentSession, manifest: WishlistManifest) => Promise<unknown>;
  writeBasePlan: (session: AgentSession, draft: BasePlanDraft) => Promise<unknown>;
}>): GalacticTycoonsClient {
  return {
    getSnapshot: overrides.getSnapshot ?? vi.fn(async () => mockSnapshot()),
    writeWishlist: overrides.writeWishlist ?? vi.fn(async () => ({ status: "created" })),
    writeBasePlan: overrides.writeBasePlan ?? vi.fn(async () => ({ status: "saved" }))
  } as unknown as GalacticTycoonsClient;
}
