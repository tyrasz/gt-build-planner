import type {
  BasePlanDraft,
  BuildCandidate,
  BuildPlanRequest,
  BuildPlanResponse,
  GameSnapshot,
  MaterialRequirement,
  Objective,
  PreparedCommand,
  PriceSource,
  ScoreBreakdown,
  WishlistManifest
} from "./schemas.js";

type MaterialInfo = {
  id: number;
  name: string;
  weight: number;
  catalogPrice: number;
};

type PriceInfo = {
  unitPrice?: number;
  source: PriceSource;
};

type PlannerContext = {
  snapshot: GameSnapshot;
  request: BuildPlanRequest;
  company: {
    id?: number;
    name: string;
    cash: number;
    value?: number;
    prestige?: number;
    maxTech: number;
  };
  materials: Map<number, MaterialInfo>;
  prices: Map<number, PriceInfo>;
  owned: Map<number, number>;
  bases: BaseProfile[];
  warehouses: WarehouseProfile[];
  buildingNames: Map<number, string>;
  recipes: Record<string, unknown>[];
  baseBuildingCost: CostItem[];
};

type CostItem = {
  matId: number;
  amount: number;
};

type BaseProfile = {
  id?: number;
  name: string;
  planetId?: number;
  planetName?: string;
  warehouseId?: number;
  exp: number;
  buildingSlots: Record<string, unknown>[];
  productionOrders: Record<string, unknown>[];
};

type WarehouseProfile = {
  id?: number;
  baseId?: number;
  name: string;
  cap?: number;
  mats: CostItem[];
};

export function buildBuildPlan(snapshot: GameSnapshot, request: BuildPlanRequest): BuildPlanResponse {
  const context = buildContext(snapshot, request);
  const candidates = [
    ...buildProductionCandidates(context),
    ...buildUpgradeCandidates(context),
    ...buildWarehouseCandidates(context),
    ...buildBasePlanCandidates(context)
  ];

  if (candidates.length === 0) candidates.push(buildCashReserveCandidate(context));

  candidates.sort((left, right) => right.score - left.score);
  const selectedCandidate = candidates[0];
  const warnings = [
    ...snapshot.warnings,
    "Build requirements are deterministic estimates from public API data; verify the in-game planner before spending cash."
  ];

  return {
    generatedAt: new Date().toISOString(),
    objective: request.objective,
    company: {
      id: context.company.id,
      name: context.company.name,
      cash: context.company.cash,
      value: context.company.value,
      prestige: context.company.prestige
    },
    selectedCandidate,
    candidates: candidates.slice(0, 8),
    preparedCommands: preparedCommandsFor(selectedCandidate),
    warnings,
    rateLimits: snapshot.rateLimits
  };
}

export function mergeRequirements(requirements: MaterialRequirement[]): MaterialRequirement[] {
  const byMat = new Map<number, MaterialRequirement>();
  for (const requirement of requirements) {
    const existing = byMat.get(requirement.matId);
    if (!existing) {
      byMat.set(requirement.matId, { ...requirement });
      continue;
    }
    const requiredQty = existing.requiredQty + requirement.requiredQty;
    const ownedQty = Math.max(existing.ownedQty, requirement.ownedQty);
    const unitPrice = existing.unitPrice ?? requirement.unitPrice;
    const deficitQty = Math.max(0, requiredQty - ownedQty);
    byMat.set(requirement.matId, {
      ...existing,
      requiredQty,
      ownedQty,
      deficitQty,
      tonnes: optionalSum(existing.tonnes, requirement.tonnes),
      estimatedCost: unitPrice === undefined ? undefined : deficitQty * unitPrice,
      unitPrice,
      priceSource: strongerPriceSource(existing.priceSource, requirement.priceSource)
    });
  }
  return [...byMat.values()].sort((left, right) => (right.estimatedCost ?? 0) - (left.estimatedCost ?? 0));
}

function buildContext(snapshot: GameSnapshot, request: BuildPlanRequest): PlannerContext {
  const gameData = asRecord(snapshot.gameData);
  const materials = materialIndex(recordArray(gameData.materials));
  const prices = priceIndex(snapshot.market.prices, materials);
  const warehouses = collectWarehouses(snapshot, materials);
  const owned = ownedIndex(warehouses);

  return {
    snapshot,
    request,
    company: companyProfile(snapshot.company),
    materials,
    prices,
    owned,
    bases: collectBases(snapshot),
    warehouses,
    buildingNames: buildingNameIndex(recordArray(gameData.buildings)),
    recipes: recordArray(gameData.recipes),
    baseBuildingCost: parseCostItems(gameData.baseBuildingCost)
  };
}

function buildProductionCandidates(context: PlannerContext): BuildCandidate[] {
  const targetBase = context.bases[0];
  if (!targetBase) return [];

  const candidates: BuildCandidate[] = [];
  for (const recipe of context.recipes) {
    const recipeId = numberValue(recipe.id);
    const producedIn = numberValue(recipe.producedIn);
    const reqTech = numberValue(recipe.reqTech) ?? 0;
    const timeMinutes = Math.max(1, numberValue(recipe.timeMinutes) ?? 60);
    const inputs = parseCostItems(recipe.inputs);
    const output = parseSingleCost(recipe.output);
    if (!recipeId || !producedIn || !output || inputs.length === 0 || reqTech > context.company.maxTech + 1) continue;

    const outputPrice = priceFor(context, output.matId).unitPrice;
    if (!outputPrice) continue;

    const inputCost = inputs.reduce((total, item) => total + item.amount * (priceFor(context, item.matId).unitPrice ?? 0), 0);
    const outputValue = output.amount * outputPrice;
    const profitPerBatch = outputValue - inputCost;
    if (profitPerBatch <= 0) continue;

    const batches = Math.max(1, Math.ceil((Math.min(context.request.horizonHours, 24) * 60) / timeMinutes));
    const requirements = requirementsFromCostItems(context, inputs, batches);
    const marginPct = inputCost > 0 ? profitPerBatch / inputCost : 1;
    const buildingName = context.buildingNames.get(producedIn) ?? `Building ${producedIn}`;
    const outputName = materialName(context, output.matId);
    const draft = draftBasePlan(context, targetBase, producedIn, `${outputName} line`);
    const impact = clamp(18 + marginPct * 28, 18, 45);

    candidates.push(scoreCandidate(context, {
      id: `production-${recipeId}`,
      title: `Stage ${outputName} production`,
      kind: "production_chain",
      target: {
        baseId: targetBase.id,
        baseName: targetBase.name,
        planetId: targetBase.planetId,
        planetName: targetBase.planetName,
        buildingType: producedIn,
        buildingName,
        recipeId,
        outputMatId: output.matId,
        outputMatName: outputName
      },
      summary: `Prepare ${batches} batch${batches === 1 ? "" : "es"} of ${outputName} using current input and output prices.`,
      impact,
      requirements,
      basePlanDraft: draft,
      rationale: [
        `Estimated batch margin is ${Math.round(marginPct * 100)}%.`,
        `Recipe fits current or near-current technology level ${reqTech}.`,
        `Planner uses ${Math.min(context.request.horizonHours, 24)}h of input coverage for the first run.`
      ],
      warnings: []
    }));
  }

  return candidates.sort((left, right) => right.score - left.score).slice(0, 5);
}

function buildUpgradeCandidates(context: PlannerContext): BuildCandidate[] {
  const candidates: BuildCandidate[] = [];
  for (const base of context.bases) {
    for (const slot of base.buildingSlots.slice(0, 25)) {
      const building = asRecord(slot.building);
      const buildingType = numberValue(building.type) ?? numberValue(slot.buildingType);
      const currentLevel = numberValue(building.level) ?? numberValue(slot.level) ?? 0;
      if (!buildingType || currentLevel <= 0) continue;

      const multiplier = 1 + currentLevel * 0.35;
      const requirements = requirementsFromCostItems(context, context.baseBuildingCost, multiplier);
      const buildingName = context.buildingNames.get(buildingType) ?? `Building ${buildingType}`;
      const condition = numberValue(building.cond);
      const conditionPenalty = condition !== undefined && condition < 0.55 ? 8 : 0;
      const impact = clamp(28 + currentLevel * 1.5 - conditionPenalty, 20, 45);
      const draft = draftBasePlan(context, base, buildingType, `${buildingName} L${currentLevel + 1}`, currentLevel + 1);

      candidates.push(scoreCandidate(context, {
        id: `upgrade-${base.id ?? "base"}-${buildingType}-${currentLevel}`,
        title: `Upgrade ${buildingName} at ${base.name}`,
        kind: "building_upgrade",
        target: {
          baseId: base.id,
          baseName: base.name,
          planetId: base.planetId,
          planetName: base.planetName,
          buildingType,
          buildingName
        },
        summary: `Estimate one level of ${buildingName} improvement at ${base.name}.`,
        impact,
        requirements,
        basePlanDraft: draft,
        rationale: [
          `Current visible level is ${currentLevel}.`,
          "Upgrade scoring favors existing productive assets because they usually improve value without adding a new base."
        ],
        warnings: conditionPenalty ? ["Building condition looks low; repair may be a better first action."] : []
      }));
    }
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 5);
}

function buildWarehouseCandidates(context: PlannerContext): BuildCandidate[] {
  const warehouseBuildingType = findBuildingType(context, "warehouse");
  const candidates: BuildCandidate[] = [];
  for (const warehouse of context.warehouses) {
    if (!warehouse.cap || warehouse.cap <= 0) continue;
    const usedTonnes = warehouse.mats.reduce((total, item) => total + item.amount * (context.materials.get(item.matId)?.weight ?? 0), 0);
    const utilization = usedTonnes / warehouse.cap;
    if (utilization < 0.78) continue;

    const base = context.bases.find((item) => item.warehouseId === warehouse.id || item.id === warehouse.baseId) ?? context.bases[0];
    const requirements = requirementsFromCostItems(context, context.baseBuildingCost, 1.2);
    const draft = base ? draftBasePlan(context, base, warehouseBuildingType, "Warehouse relief") : undefined;
    const impact = clamp(22 + utilization * 28, 25, 48);

    candidates.push(scoreCandidate(context, {
      id: `warehouse-${warehouse.id ?? warehouse.name}`,
      title: `Relieve storage pressure at ${base?.name ?? warehouse.name}`,
      kind: "warehouse_capacity",
      target: {
        baseId: base?.id,
        baseName: base?.name,
        planetId: base?.planetId,
        planetName: base?.planetName,
        buildingType: warehouseBuildingType,
        buildingName: warehouseBuildingType ? context.buildingNames.get(warehouseBuildingType) : undefined
      },
      summary: `${warehouse.name} is about ${Math.round(utilization * 100)}% full.`,
      impact,
      requirements,
      basePlanDraft: draft,
      rationale: [
        `Stored material weight is approximately ${Math.round(usedTonnes).toLocaleString()} tonnes.`,
        "Storage relief protects production uptime and avoids forced selling."
      ],
      warnings: []
    }));
  }
  return candidates;
}

function buildBasePlanCandidates(context: PlannerContext): BuildCandidate[] {
  const candidates: BuildCandidate[] = [];
  for (const plan of context.snapshot.basePlans.slice(0, 8)) {
    const draft = parseBasePlanDraft(plan);
    if (!draft) continue;
    const base = context.bases.find((item) => item.planetId === draft.id || item.id === draft.id);
    const plannedSlots = draft.slots.filter((slot) => slot.buildingType > 0).length;
    const requirements = requirementsFromCostItems(context, context.baseBuildingCost, Math.max(1, plannedSlots));
    const impact = clamp(24 + plannedSlots * 4 + draft.exp * 8, 24, 50);
    const title = draft.title || `Planet ${draft.id} base plan`;

    candidates.push(scoreCandidate(context, {
      id: `base-plan-${draft.id}`,
      title: `Execute reviewed plan: ${title}`,
      kind: "base_plan",
      target: {
        baseId: base?.id,
        baseName: base?.name,
        planetId: draft.id,
        planetName: base?.planetName
      },
      summary: `Existing base plan includes ${plannedSlots} planned building slot${plannedSlots === 1 ? "" : "s"} and ${draft.exp} expansion target${draft.exp === 1 ? "" : "s"}.`,
      impact,
      requirements,
      basePlanDraft: draft,
      rationale: [
        "A saved in-game base plan is already present, so this candidate focuses on material readiness and cash fit.",
        "Use the write endpoint only after comparing this draft against the in-game planner."
      ],
      warnings: []
    }));
  }
  return candidates;
}

function buildCashReserveCandidate(context: PlannerContext): BuildCandidate {
  return scoreCandidate(context, {
    id: "cash-reserve",
    title: "Hold cash and collect more live data",
    kind: "cash_reserve",
    target: {},
    summary: "No high-confidence build target was visible from the current API snapshot.",
    impact: 8,
    requirements: [],
    rationale: [
      "The planner could not find profitable production, urgent storage pressure, visible upgrades, or saved base plans.",
      "Re-run after production orders, base details, or market data are available."
    ],
    warnings: []
  });
}

function scoreCandidate(
  context: PlannerContext,
  input: Omit<BuildCandidate, "score" | "scoreBreakdown" | "estimatedCost" | "cashAfter" | "confidence" | "wishlistManifest" | "blockers"> & {
    impact: number;
  }
): BuildCandidate {
  const { impact, ...candidateInput } = input;
  const estimatedCost = round(input.requirements.reduce((total, item) => total + (item.estimatedCost ?? 0), 0));
  const cashAfter = context.company.cash - estimatedCost;
  const reserve = context.company.cash * (context.request.cashReservePct / 100);
  const maxSpend = context.company.cash * (context.request.maxSpendPct / 100);
  const blockers: string[] = [];
  if (estimatedCost > maxSpend) blockers.push(`Estimated cost exceeds the ${context.request.maxSpendPct}% max spend guardrail.`);
  if (cashAfter < reserve) blockers.push(`Estimated spend would break the ${context.request.cashReservePct}% cash reserve.`);
  if (input.requirements.some((item) => item.deficitQty > 0 && item.priceSource === "missing")) {
    blockers.push("One or more missing materials have no market or catalog price.");
  }

  const coverage = input.requirements.length === 0
    ? 0.5
    : avg(input.requirements.map((item) => item.requiredQty > 0 ? clamp(item.ownedQty / item.requiredQty, 0, 1) : 1));
  const pricedShare = input.requirements.length === 0
    ? 1
    : input.requirements.filter((item) => item.priceSource !== "missing").length / input.requirements.length;
  const costFit = estimatedCost <= 0 ? 18 : clamp(25 * (1 - estimatedCost / Math.max(1, maxSpend)), 0, 25);
  const objectiveScore = objectiveFit(context.request.objective, input.kind);
  const constraints = -blockers.length * 10;
  const scoreBreakdown: ScoreBreakdown = {
    impact: round(input.impact),
    costFit: round(costFit),
    inventoryCoverage: round(coverage * 20),
    marketAvailability: round(pricedShare * 15),
    constraints,
    objectiveFit: objectiveScore
  };
  const score = round(Object.values(scoreBreakdown).reduce((total, value) => total + value, 0));
  const confidence = blockers.length > 0 || pricedShare < 0.6 ? "low" : pricedShare > 0.9 && coverage > 0.4 ? "high" : "medium";
  const wishlistManifest = buildWishlist(input.title, input.id, input.requirements);

  return {
    ...candidateInput,
    score,
    scoreBreakdown,
    estimatedCost,
    cashAfter,
    confidence,
    blockers,
    wishlistManifest
  };
}

function preparedCommandsFor(candidate: BuildCandidate): PreparedCommand[] {
  const commands: PreparedCommand[] = [
    {
      type: "review",
      title: `Review ${candidate.title}`,
      executable: false,
      payload: { candidateId: candidate.id, kind: candidate.kind, target: candidate.target },
      steps: [
        "Open the matching base, planet, or production screen in Galactic Tycoons.",
        "Compare the live in-game requirements with this deterministic estimate.",
        "Spend cash only if the live planner still matches the selected candidate."
      ]
    }
  ];
  if (candidate.wishlistManifest?.materials.some((item) => item.deficitQty > 0)) {
    commands.push({
      type: "create_wishlist",
      title: `Prepare wishlist: ${candidate.wishlistManifest.title}`,
      executable: false,
      payload: candidate.wishlistManifest,
      steps: [
        "Review missing materials.",
        "Use Create wishlist only after explicit confirmation.",
        "If the API key lacks write access, use the manual manifest."
      ]
    });
  }
  if (candidate.basePlanDraft) {
    commands.push({
      type: "save_base_plan",
      title: `Prepare base plan draft: ${candidate.basePlanDraft.title ?? `Planet ${candidate.basePlanDraft.id}`}`,
      executable: false,
      payload: candidate.basePlanDraft,
      steps: [
        "Review affected slots and target levels.",
        "Use Save base plan only after explicit confirmation.",
        "If the API endpoint rejects the draft, copy the manual plan into the in-game planner."
      ]
    });
  }
  return commands;
}

function buildWishlist(title: string, id: string, requirements: MaterialRequirement[]): WishlistManifest | undefined {
  const missing = requirements.filter((item) => item.deficitQty > 0);
  if (missing.length === 0) return undefined;
  return {
    title: `GT Agent - ${title}`.slice(0, 120),
    materials: missing,
    sourceCandidateId: id
  };
}

function requirementsFromCostItems(context: PlannerContext, items: CostItem[], multiplier: number): MaterialRequirement[] {
  return mergeRequirements(items.map((item) => {
    const requiredQty = round(item.amount * multiplier);
    const ownedQty = context.owned.get(item.matId) ?? 0;
    const price = priceFor(context, item.matId);
    const deficitQty = Math.max(0, requiredQty - ownedQty);
    const material = context.materials.get(item.matId);
    return {
      matId: item.matId,
      matName: materialName(context, item.matId),
      requiredQty,
      ownedQty,
      deficitQty,
      tonnes: material ? round(requiredQty * material.weight) : undefined,
      estimatedCost: price.unitPrice === undefined ? undefined : round(deficitQty * price.unitPrice),
      unitPrice: price.unitPrice,
      priceSource: price.source
    };
  }));
}

function draftBasePlan(
  context: PlannerContext,
  base: BaseProfile,
  buildingType: number | undefined,
  label: string,
  targetLevel = 1
): BasePlanDraft | undefined {
  const planetId = base.planetId ?? base.id;
  if (!planetId || !buildingType) return undefined;
  const existing = context.snapshot.basePlans.map(parseBasePlanDraft).find((plan) => plan?.id === planetId);
  const baseSlots = slotDraftsFromBase(base);
  const slots = existing?.slots.length ? [...existing.slots] : baseSlots;
  const affected = slots.find((slot) => slot.buildingType === 0) ?? slots[0] ?? { id: 1, status: 0, buildingType: 0, level: 0 };
  const nextSlots = slots.filter((slot) => slot.id !== affected.id);
  nextSlots.push({ ...affected, buildingType, level: Math.max(targetLevel, affected.level || 1), status: affected.status || 1 });
  nextSlots.sort((left, right) => left.id - right.id);
  return {
    id: planetId,
    title: label.slice(0, 40),
    exp: clamp(base.exp, 0, 2),
    slots: nextSlots
  };
}

function parseBasePlanDraft(value: unknown): BasePlanDraft | undefined {
  const record = asRecord(value);
  const id = numberValue(record.id);
  if (!id) return undefined;
  return {
    id,
    title: textValue(record.title) ?? null,
    exp: clamp(numberValue(record.exp) ?? 0, 0, 2),
    slots: recordArray(record.slots).map((slot, index) => ({
      id: numberValue(slot.id) ?? index + 1,
      status: numberValue(slot.status) ?? 0,
      buildingType: numberValue(slot.buildingType) ?? 0,
      level: numberValue(slot.level) ?? 0
    }))
  };
}

function slotDraftsFromBase(base: BaseProfile) {
  return base.buildingSlots.map((slot, index) => {
    const building = asRecord(slot.building);
    return {
      id: numberValue(slot.id) ?? index + 1,
      status: numberValue(slot.status) ?? 0,
      buildingType: numberValue(building.type) ?? numberValue(slot.buildingType) ?? 0,
      level: numberValue(building.level) ?? numberValue(slot.level) ?? 0
    };
  });
}

function companyProfile(company: Record<string, unknown>): PlannerContext["company"] {
  const technologies = recordArray(company.technologies);
  return {
    id: numberValue(company.id),
    name: textValue(company.name) ?? "Unknown company",
    cash: numberValue(company.cash) ?? 0,
    value: numberValue(company.value),
    prestige: numberValue(company.pr),
    maxTech: Math.max(0, ...technologies.map((tech) => numberValue(tech.level) ?? 0))
  };
}

function collectBases(snapshot: GameSnapshot): BaseProfile[] {
  const byId = new Map<number, BaseProfile>();
  const companyBases = recordArray(snapshot.company.bases);
  for (const base of [...companyBases, ...snapshot.bases]) {
    const id = numberValue(base.id);
    const existing = id ? byId.get(id) : undefined;
    const profile: BaseProfile = {
      id,
      name: textValue(base.name) ?? existing?.name ?? `Base ${id ?? byId.size + 1}`,
      planetId: numberValue(base.planetId) ?? numberValue(base.pId) ?? existing?.planetId,
      planetName: textValue(base.planetName) ?? textValue(base.pName) ?? existing?.planetName,
      warehouseId: numberValue(base.warehouseId) ?? numberValue(base.whId) ?? existing?.warehouseId,
      exp: numberValue(base.exp) ?? existing?.exp ?? 0,
      buildingSlots: recordArray(base.buildingSlots).length ? recordArray(base.buildingSlots) : existing?.buildingSlots ?? [],
      productionOrders: recordArray(base.productionOrders).length ? recordArray(base.productionOrders) : existing?.productionOrders ?? []
    };
    if (id) byId.set(id, profile);
  }
  return [...byId.values()];
}

function collectWarehouses(snapshot: GameSnapshot, materials: Map<number, MaterialInfo>): WarehouseProfile[] {
  const warehouses = snapshot.warehouses.map((warehouse, index) => parseWarehouse(warehouse, materials, index));
  for (const base of snapshot.bases) {
    const embedded = asRecord(base.warehouse);
    if (Object.keys(embedded).length > 0) {
      warehouses.push({
        ...parseWarehouse(embedded, materials, warehouses.length),
        baseId: numberValue(base.id)
      });
    }
  }
  return warehouses;
}

function parseWarehouse(warehouse: Record<string, unknown>, materials: Map<number, MaterialInfo>, index: number): WarehouseProfile {
  return {
    id: numberValue(warehouse.id),
    name: textValue(warehouse.name) ?? `Warehouse ${numberValue(warehouse.id) ?? index + 1}`,
    cap: numberValue(warehouse.cap) ?? numberValue(warehouse.capacity),
    mats: recordArray(warehouse.mats).map((mat) => ({
      matId: numberValue(mat.id) ?? numberValue(mat.matId) ?? 0,
      amount: numberValue(mat.am) ?? numberValue(mat.amount) ?? numberValue(mat.qty) ?? 0
    })).filter((item) => item.matId > 0 && item.amount > 0 && materials.has(item.matId))
  };
}

function materialIndex(materials: Record<string, unknown>[]): Map<number, MaterialInfo> {
  const index = new Map<number, MaterialInfo>();
  for (const material of materials) {
    const id = numberValue(material.id);
    if (!id) continue;
    index.set(id, {
      id,
      name: textValue(material.name) ?? textValue(material.sName) ?? `Material ${id}`,
      weight: numberValue(material.weight) ?? 0,
      catalogPrice: numberValue(material.cp) ?? 0
    });
  }
  return index;
}

function priceIndex(prices: Record<string, unknown>[], materials: Map<number, MaterialInfo>): Map<number, PriceInfo> {
  const index = new Map<number, PriceInfo>();
  for (const price of prices) {
    const matId = numberValue(price.matId) ?? numberValue(price.id);
    if (!matId) continue;
    const current = numberValue(price.currentPrice);
    const average = numberValue(price.avgPrice);
    if (current !== undefined && current > 0) index.set(matId, { unitPrice: current, source: "market" });
    else if (average !== undefined && average > 0) index.set(matId, { unitPrice: average, source: "average" });
  }
  for (const [matId, material] of materials) {
    if (!index.has(matId) && material.catalogPrice > 0) index.set(matId, { unitPrice: material.catalogPrice, source: "catalog" });
  }
  return index;
}

function ownedIndex(warehouses: WarehouseProfile[]): Map<number, number> {
  const owned = new Map<number, number>();
  for (const warehouse of warehouses) {
    for (const item of warehouse.mats) {
      owned.set(item.matId, (owned.get(item.matId) ?? 0) + item.amount);
    }
  }
  return owned;
}

function buildingNameIndex(buildings: Record<string, unknown>[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const building of buildings) {
    const id = numberValue(building.id) ?? numberValue(building.type);
    if (id) names.set(id, textValue(building.name) ?? `Building ${id}`);
  }
  return names;
}

function parseCostItems(value: unknown): CostItem[] {
  return recordArray(value).map((item) => {
    const record = asRecord(item.cost);
    return {
      matId: numberValue(item.id) ?? numberValue(item.i) ?? numberValue(record.id) ?? numberValue(record.i) ?? 0,
      amount: numberValue(item.am) ?? numberValue(item.a) ?? numberValue(record.am) ?? numberValue(record.a) ?? 0
    };
  }).filter((item) => item.matId > 0 && item.amount > 0);
}

function parseSingleCost(value: unknown): CostItem | undefined {
  const record = asRecord(value);
  const matId = numberValue(record.id) ?? numberValue(record.i);
  const amount = numberValue(record.am) ?? numberValue(record.a);
  return matId && amount ? { matId, amount } : undefined;
}

function priceFor(context: PlannerContext, matId: number): PriceInfo {
  return context.prices.get(matId) ?? { source: "missing" };
}

function materialName(context: PlannerContext, matId: number): string {
  return context.materials.get(matId)?.name ?? `Material ${matId}`;
}

function findBuildingType(context: PlannerContext, fragment: string): number | undefined {
  const needle = fragment.toLowerCase();
  for (const [id, name] of context.buildingNames) {
    if (name.toLowerCase().includes(needle)) return id;
  }
  return undefined;
}

function objectiveFit(objective: Objective, kind: BuildCandidate["kind"]): number {
  if (objective === "infer") return 8;
  if (objective === "profit_per_hour") return kind === "production_chain" ? 14 : kind === "building_upgrade" ? 10 : 4;
  if (objective === "production_uptime") return kind === "warehouse_capacity" ? 14 : kind === "production_chain" ? 10 : 5;
  if (objective === "cv_growth") return kind === "base_plan" || kind === "building_upgrade" ? 14 : 5;
  return 0;
}

function strongerPriceSource(left: PriceSource, right: PriceSource): PriceSource {
  const order: PriceSource[] = ["missing", "catalog", "average", "market"];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function avg(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function optionalSum(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
