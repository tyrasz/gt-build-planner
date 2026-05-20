import { z } from "zod";

export const sessionKeysRequestSchema = z.object({
  gtApiKey: z.string().trim().min(8, "Enter a Galactic Tycoons API key.")
});
export type SessionKeysRequest = z.infer<typeof sessionKeysRequestSchema>;

export const objectiveSchema = z.enum(["infer", "profit_per_hour", "production_uptime", "cv_growth"]);
export type Objective = z.infer<typeof objectiveSchema>;

export const buildPlanRequestSchema = z.object({
  objective: objectiveSchema.default("infer"),
  horizonHours: z.number().min(1).max(168).default(24),
  cashReservePct: z.number().min(0).max(90).default(25),
  maxSpendPct: z.number().min(1).max(100).default(75)
});
export type BuildPlanRequest = z.infer<typeof buildPlanRequestSchema>;

export const rateLimitInfoSchema = z.object({
  endpoint: z.string(),
  remaining: z.number().optional(),
  resetSeconds: z.number().optional(),
  retryAfterSeconds: z.number().optional()
});
export type RateLimitInfo = z.infer<typeof rateLimitInfoSchema>;

export const gameSnapshotSchema = z.object({
  fetchedAt: z.string(),
  company: z.record(z.unknown()),
  bases: z.array(z.record(z.unknown())),
  warehouses: z.array(z.record(z.unknown())),
  exchangeOrders: z.array(z.record(z.unknown())),
  cashHistory: z.array(z.record(z.unknown())),
  contracts: z.array(z.record(z.unknown())),
  basePlans: z.array(z.record(z.unknown())),
  wishlists: z.array(z.record(z.unknown())),
  market: z.object({
    prices: z.array(z.record(z.unknown())),
    details: z.array(z.record(z.unknown()))
  }),
  gameData: z.record(z.unknown()),
  rateLimits: z.array(rateLimitInfoSchema).default([]),
  warnings: z.array(z.string()).default([])
});
export type GameSnapshot = z.infer<typeof gameSnapshotSchema>;

export const priceSourceSchema = z.enum(["market", "average", "catalog", "missing"]);
export type PriceSource = z.infer<typeof priceSourceSchema>;

export const materialRequirementSchema = z.object({
  matId: z.number(),
  matName: z.string(),
  requiredQty: z.number(),
  ownedQty: z.number(),
  deficitQty: z.number(),
  tonnes: z.number().optional(),
  estimatedCost: z.number().optional(),
  unitPrice: z.number().optional(),
  priceSource: priceSourceSchema
});
export type MaterialRequirement = z.infer<typeof materialRequirementSchema>;

export const wishlistManifestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  wishlistId: z.number().optional(),
  materials: z.array(materialRequirementSchema).default([]),
  sourceCandidateId: z.string().optional()
});
export type WishlistManifest = z.infer<typeof wishlistManifestSchema>;

export const basePlanSlotSchema = z.object({
  id: z.number(),
  status: z.number(),
  buildingType: z.number(),
  level: z.number()
});
export type BasePlanSlot = z.infer<typeof basePlanSlotSchema>;

export const basePlanDraftSchema = z.object({
  id: z.number(),
  title: z.string().trim().max(40).nullable(),
  exp: z.number().min(0).max(2),
  slots: z.array(basePlanSlotSchema).default([])
});
export type BasePlanDraft = z.infer<typeof basePlanDraftSchema>;

export const scoreBreakdownSchema = z.object({
  impact: z.number(),
  costFit: z.number(),
  inventoryCoverage: z.number(),
  marketAvailability: z.number(),
  constraints: z.number(),
  objectiveFit: z.number()
});
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;

export const buildCandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["base_plan", "building_upgrade", "production_chain", "warehouse_capacity", "cash_reserve"]),
  target: z.object({
    baseId: z.number().optional(),
    baseName: z.string().optional(),
    planetId: z.number().optional(),
    planetName: z.string().optional(),
    buildingType: z.number().optional(),
    buildingName: z.string().optional(),
    recipeId: z.number().optional(),
    outputMatId: z.number().optional(),
    outputMatName: z.string().optional()
  }),
  summary: z.string(),
  score: z.number(),
  scoreBreakdown: scoreBreakdownSchema,
  estimatedCost: z.number(),
  cashAfter: z.number(),
  confidence: z.enum(["low", "medium", "high"]),
  requirements: z.array(materialRequirementSchema).default([]),
  blockers: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  rationale: z.array(z.string()).default([]),
  basePlanDraft: basePlanDraftSchema.optional(),
  wishlistManifest: wishlistManifestSchema.optional()
});
export type BuildCandidate = z.infer<typeof buildCandidateSchema>;

export const preparedCommandSchema = z.object({
  type: z.enum(["review", "create_wishlist", "save_base_plan"]),
  title: z.string(),
  executable: z.literal(false),
  payload: z.record(z.unknown()).default({}),
  steps: z.array(z.string()).default([])
});
export type PreparedCommand = z.infer<typeof preparedCommandSchema>;

export const buildPlanResponseSchema = z.object({
  generatedAt: z.string(),
  objective: objectiveSchema,
  company: z.object({
    id: z.number().optional(),
    name: z.string(),
    cash: z.number(),
    value: z.number().optional(),
    prestige: z.number().optional()
  }),
  selectedCandidate: buildCandidateSchema,
  candidates: z.array(buildCandidateSchema),
  preparedCommands: z.array(preparedCommandSchema).default([]),
  warnings: z.array(z.string()).default([]),
  rateLimits: z.array(rateLimitInfoSchema).default([])
});
export type BuildPlanResponse = z.infer<typeof buildPlanResponseSchema>;

export const wishlistWriteRequestSchema = z.object({
  manifest: wishlistManifestSchema,
  confirmed: z.boolean().default(false)
});
export type WishlistWriteRequest = z.infer<typeof wishlistWriteRequestSchema>;

export const wishlistWriteResultSchema = z.object({
  status: z.enum(["created", "updated", "manual_only"]),
  title: z.string(),
  wishlistId: z.number().optional(),
  writeAttempted: z.boolean(),
  message: z.string(),
  manifest: wishlistManifestSchema,
  warnings: z.array(z.string()).default([])
});
export type WishlistWriteResult = z.infer<typeof wishlistWriteResultSchema>;

export const basePlanWriteRequestSchema = z.object({
  draft: basePlanDraftSchema,
  confirmed: z.boolean().default(false)
});
export type BasePlanWriteRequest = z.infer<typeof basePlanWriteRequestSchema>;

export const basePlanWriteResultSchema = z.object({
  status: z.enum(["saved", "manual_only"]),
  planId: z.number(),
  writeAttempted: z.boolean(),
  message: z.string(),
  draft: basePlanDraftSchema,
  warnings: z.array(z.string()).default([])
});
export type BasePlanWriteResult = z.infer<typeof basePlanWriteResultSchema>;

export const refreshOptionsSchema = z.object({
  forceCompany: z.boolean().optional(),
  forceMarket: z.boolean().optional(),
  forceGameData: z.boolean().optional()
}).optional();
export type RefreshOptions = z.infer<typeof refreshOptionsSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional()
});
export type ApiError = z.infer<typeof apiErrorSchema>;
