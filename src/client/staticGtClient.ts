import type {
  BasePlanDraft,
  BasePlanWriteResult,
  GameSnapshot,
  RateLimitInfo,
  WishlistManifest,
  WishlistWriteResult
} from "../shared/schemas";

const GT_BASE_URL = "https://api.g2.galactictycoons.com";

export async function getStaticSnapshot(gtApiKey: string): Promise<GameSnapshot> {
  const warnings: string[] = [];
  const rateLimits: RateLimitInfo[] = [];

  const [gameData, prices, details, companyParts] = await Promise.all([
    fetchJson<Record<string, unknown>>("/gamedata.json").catch((error) => {
      warnings.push(`Could not load game data: ${describeError(error)}.`);
      return {};
    }),
    fetchJson<{ prices?: Record<string, unknown>[] }>("/public/exchange/mat-prices", gtApiKey).catch((error) => {
      warnings.push(`Could not load exchange prices: ${describeError(error)}.`);
      return { prices: [] };
    }),
    fetchJson<{ materials?: Record<string, unknown>[] }>("/public/exchange/mat-details", gtApiKey).catch((error) => {
      warnings.push(`Could not load exchange details: ${describeError(error)}.`);
      return { materials: [] };
    }),
    getCompanyParts(gtApiKey, rateLimits, warnings)
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    company: companyParts.company,
    bases: companyParts.bases,
    warehouses: companyParts.warehouses,
    exchangeOrders: companyParts.exchangeOrders,
    cashHistory: companyParts.cashHistory,
    contracts: companyParts.contracts,
    basePlans: companyParts.basePlans,
    wishlists: companyParts.wishlists,
    market: {
      prices: Array.isArray(prices.prices) ? prices.prices : [],
      details: Array.isArray(details.materials) ? details.materials : []
    },
    gameData,
    rateLimits,
    warnings
  };
}

export async function writeStaticWishlist(gtApiKey: string, manifest: WishlistManifest): Promise<WishlistWriteResult> {
  const mats = manifest.materials
    .filter((material) => material.deficitQty > 0)
    .map((material) => ({ id: material.matId, qty: Math.ceil(material.deficitQty) }));

  if (mats.length === 0) {
    return {
      status: "manual_only",
      title: manifest.title,
      wishlistId: manifest.wishlistId,
      writeAttempted: false,
      message: "Wishlist has no missing materials to write.",
      manifest,
      warnings: []
    };
  }

  const endpoint = manifest.wishlistId ? `/public/wishlist/${manifest.wishlistId}/additems` : "/public/wishlist/create";
  const payload = manifest.wishlistId ? { mats } : { title: manifest.title, mats };
  const body = await fetchJson<Record<string, unknown>>(endpoint, gtApiKey, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const wishlistId = numberValue(body.id) ?? numberValue(body.wishlistId) ?? manifest.wishlistId;

  return {
    status: manifest.wishlistId ? "updated" : "created",
    title: manifest.title,
    wishlistId,
    writeAttempted: true,
    message: manifest.wishlistId ? "Wishlist was updated in Galactic Tycoons." : "Wishlist was created in Galactic Tycoons.",
    manifest,
    warnings: []
  };
}

export async function writeStaticBasePlan(gtApiKey: string, draft: BasePlanDraft): Promise<BasePlanWriteResult> {
  await fetchJson<Record<string, unknown>>("/public/company/baseplan", gtApiKey, {
    method: "POST",
    body: JSON.stringify(draft)
  });
  return {
    status: "saved",
    planId: draft.id,
    writeAttempted: true,
    message: "Base plan draft was sent to Galactic Tycoons.",
    draft,
    warnings: []
  };
}

async function getCompanyParts(gtApiKey: string, rateLimits: RateLimitInfo[], warnings: string[]) {
  const endpoints = [
    ["company", "/public/company"],
    ["bases", "/public/company/bases"],
    ["warehouses", "/public/company/warehouses"],
    ["exchangeOrders", "/public/company/exchangeorders"],
    ["cashHistory", "/public/company/cash-history"],
    ["contracts", "/public/company/contracts"],
    ["basePlans", "/public/company/baseplans"],
    ["wishlists", "/public/wishlists"]
  ] as const;

  const result: Record<string, unknown> = {};
  await Promise.all(endpoints.map(async ([key, endpoint]) => {
    try {
      result[key] = await fetchJson<unknown>(endpoint, gtApiKey, { onRateLimit: (rateLimit) => rateLimits.push(rateLimit) });
    } catch (error) {
      if (key === "company") throw error;
      result[key] = [];
      warnings.push(`Could not load ${key}: ${describeError(error)}. Continuing with an empty set.`);
    }
  }));

  return {
    company: asRecord(result.company),
    bases: asRecordArray(result.bases),
    warehouses: asRecordArray(result.warehouses),
    exchangeOrders: asRecordArray(result.exchangeOrders),
    cashHistory: asRecordArray(result.cashHistory),
    contracts: asRecordArray(result.contracts),
    basePlans: asRecordArray(result.basePlans),
    wishlists: asRecordArray(result.wishlists)
  };
}

async function fetchJson<T>(
  endpoint: string,
  gtApiKey?: string,
  options: { method?: string; body?: string; onRateLimit?: (rateLimit: RateLimitInfo) => void } = {}
): Promise<T> {
  const response = await fetch(`${GT_BASE_URL}${endpoint}`, {
    method: options.method ?? "GET",
    headers: {
      ...(gtApiKey ? { Authorization: `Bearer ${gtApiKey}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body
  });

  const rateLimit = parseRateLimit(endpoint, response.headers);
  if (rateLimit) options.onRateLimit?.(rateLimit);

  if (!response.ok) {
    let message = `Galactic Tycoons API returned ${response.status} for ${endpoint}.`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }

  return await response.json() as T;
}

function parseRateLimit(endpoint: string, headers: Headers): RateLimitInfo | undefined {
  const remaining = numberHeader(headers, "Rate-Remaining");
  const resetSeconds = numberHeader(headers, "Rate-Reset");
  const retryAfterSeconds = numberHeader(headers, "Retry-After");
  if (remaining === undefined && resetSeconds === undefined && retryAfterSeconds === undefined) return undefined;
  return { endpoint, remaining, resetSeconds, retryAfterSeconds };
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = Number(headers.get(name));
  return Number.isFinite(value) ? value : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
