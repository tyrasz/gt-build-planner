import { TtlCache } from "./ttlCache.js";
import type { AgentSession } from "./sessionStore.js";
import type {
  BasePlanDraft,
  BasePlanWriteResult,
  GameSnapshot,
  RateLimitInfo,
  RefreshOptions,
  WishlistManifest,
  WishlistWriteResult
} from "../shared/schemas.js";

const GT_BASE_URL = "https://api.g2.galactictycoons.com";
const GAME_DATA_TTL_MS = 24 * 60 * 60 * 1000;
const MARKET_TTL_MS = 60 * 1000;
const COMPANY_TTL_MS = 30 * 1000;
const DEFAULT_GT_FETCH_TIMEOUT_MS = 20_000;

export type FetchLike = typeof fetch;

export type GtClientOptions = {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

type SnapshotCacheValue = Omit<GameSnapshot, "fetchedAt">;

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class GtApiError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GtApiError";
  }
}

export class GalacticTycoonsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly gameDataCache = new TtlCache<Record<string, unknown>>();
  private readonly marketPricesCache = new TtlCache<Record<string, unknown>[]>();
  private readonly marketDetailsCache = new TtlCache<Record<string, unknown>[]>();
  private readonly companyCache = new TtlCache<SnapshotCacheValue>();

  constructor(options: GtClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.GT_BASE_URL ?? GT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.GT_FETCH_TIMEOUT_MS ?? DEFAULT_GT_FETCH_TIMEOUT_MS);
  }

  async getSnapshot(session: AgentSession, refresh?: RefreshOptions): Promise<GameSnapshot> {
    const warnings: string[] = [];
    const rateLimits: RateLimitInfo[] = [];
    const companyCacheKey = `company:${session.id}`;
    const cachedCompany = refresh?.forceCompany ? undefined : this.companyCache.get(companyCacheKey);

    const [gameData, prices, details, companyParts] = await Promise.all([
      this.getGameData(Boolean(refresh?.forceGameData)).catch((error) => {
        warnings.push(`Could not load game data: ${describeGtError(error)}.`);
        return {};
      }),
      this.getMarketPrices(session.gtApiKey, Boolean(refresh?.forceMarket)).catch((error) => {
        warnings.push(`Could not load exchange prices: ${describeGtError(error)}.`);
        return { value: [], rateLimits: [] as RateLimitInfo[] };
      }),
      this.getMarketDetails(session.gtApiKey, Boolean(refresh?.forceMarket)).catch((error) => {
        warnings.push(`Could not load exchange details: ${describeGtError(error)}.`);
        return { value: [], rateLimits: [] as RateLimitInfo[] };
      }),
      cachedCompany ? Promise.resolve(cachedCompany) : this.getCompanyParts(session.gtApiKey)
    ]);

    rateLimits.push(...prices.rateLimits, ...details.rateLimits);
    if ("rateLimits" in companyParts) {
      rateLimits.push(...companyParts.rateLimits);
      warnings.push(...companyParts.warnings);
    }

    const companyValue = "company" in companyParts ? companyParts : cachedCompany;
    if (!companyValue) throw new Error("Unable to load Galactic Tycoons company snapshot.");

    const core: SnapshotCacheValue = {
      company: companyValue.company,
      bases: companyValue.bases,
      warehouses: companyValue.warehouses,
      exchangeOrders: companyValue.exchangeOrders,
      cashHistory: companyValue.cashHistory,
      contracts: companyValue.contracts,
      basePlans: companyValue.basePlans,
      wishlists: companyValue.wishlists,
      market: {
        prices: prices.value,
        details: details.value
      },
      gameData,
      rateLimits,
      warnings
    };

    this.companyCache.set(companyCacheKey, core, COMPANY_TTL_MS);
    return { fetchedAt: new Date().toISOString(), ...core };
  }

  async writeWishlist(session: AgentSession, manifest: WishlistManifest): Promise<WishlistWriteResult> {
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

    const endpoint = manifest.wishlistId
      ? `/public/wishlist/${manifest.wishlistId}/additems`
      : "/public/wishlist/create";
    const payload = manifest.wishlistId ? { mats } : { title: manifest.title, mats };
    const { body } = await this.fetchJson<Record<string, unknown>>(endpoint, session.gtApiKey, {
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

  async writeBasePlan(session: AgentSession, draft: BasePlanDraft): Promise<BasePlanWriteResult> {
    await this.fetchJson<Record<string, unknown>>("/public/company/baseplan", session.gtApiKey, {
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

  private async getGameData(force: boolean): Promise<Record<string, unknown>> {
    const cached = force ? undefined : this.gameDataCache.get("gamedata");
    if (cached) return cached;
    const { body } = await this.fetchJson<Record<string, unknown>>("/gamedata.json");
    this.gameDataCache.set("gamedata", body, GAME_DATA_TTL_MS);
    return body;
  }

  private async getMarketPrices(apiKey: string, force: boolean) {
    const cached = force ? undefined : this.marketPricesCache.get("prices");
    if (cached) return { value: cached, rateLimits: [] as RateLimitInfo[] };
    const { body, rateLimit } = await this.fetchJson<{ prices?: Record<string, unknown>[] }>(
      "/public/exchange/mat-prices",
      apiKey
    );
    const prices = Array.isArray(body.prices) ? body.prices : [];
    this.marketPricesCache.set("prices", prices, MARKET_TTL_MS);
    return { value: prices, rateLimits: rateLimit ? [rateLimit] : [] };
  }

  private async getMarketDetails(apiKey: string, force: boolean) {
    const cached = force ? undefined : this.marketDetailsCache.get("details");
    if (cached) return { value: cached, rateLimits: [] as RateLimitInfo[] };
    const { body, rateLimit } = await this.fetchJson<{ materials?: Record<string, unknown>[] }>(
      "/public/exchange/mat-details",
      apiKey
    );
    const details = Array.isArray(body.materials) ? body.materials : [];
    this.marketDetailsCache.set("details", details, MARKET_TTL_MS);
    return { value: details, rateLimits: rateLimit ? [rateLimit] : [] };
  }

  private async getCompanyParts(apiKey: string): Promise<SnapshotCacheValue & { rateLimits: RateLimitInfo[] }> {
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
    const rateLimits: RateLimitInfo[] = [];
    const warnings: string[] = [];

    await Promise.all(
      endpoints.map(async ([key, endpoint]) => {
        try {
          const { body, rateLimit } = await this.fetchJson<unknown>(endpoint, apiKey);
          result[key] = body;
          if (rateLimit) rateLimits.push(rateLimit);
        } catch (error) {
          if (key === "company") throw error;
          result[key] = [];
          warnings.push(`Could not load ${key}: ${describeGtError(error)}. Continuing with an empty set.`);
        }
      })
    );

    return {
      company: asRecord(result.company),
      bases: asRecordArray(result.bases),
      warehouses: asRecordArray(result.warehouses),
      exchangeOrders: asRecordArray(result.exchangeOrders),
      cashHistory: asRecordArray(result.cashHistory),
      contracts: asRecordArray(result.contracts),
      basePlans: asRecordArray(result.basePlans),
      wishlists: asRecordArray(result.wishlists),
      market: { prices: [], details: [] },
      gameData: {},
      rateLimits,
      warnings
    };
  }

  private async fetchJson<T>(
    endpoint: string,
    apiKey?: string,
    options: { method?: string; body?: string } = {}
  ): Promise<{ body: T; rateLimit?: RateLimitInfo }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: options.method ?? "GET",
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        body: options.body,
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new GtApiError(`Galactic Tycoons request timed out after ${Math.round(this.timeoutMs / 1000)}s.`, endpoint, 504);
      }
      throw new GtApiError(error instanceof Error ? error.message : "Galactic Tycoons request failed.", endpoint);
    } finally {
      clearTimeout(timeout);
    }

    const rateLimit = parseRateLimit(endpoint, response.headers);
    if (response.status === 429) {
      throw new RateLimitError("Galactic Tycoons API rate limit exceeded.", endpoint, rateLimit?.retryAfterSeconds);
    }

    if (!response.ok) {
      let message = `Galactic Tycoons API returned ${response.status} for ${endpoint}.`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the status-based message.
      }
      throw new GtApiError(message, endpoint, response.status);
    }

    return { body: (await response.json()) as T, rateLimit };
  }
}

export function describeGtError(error: unknown): string {
  if (error instanceof RateLimitError) {
    return `${error.message}${error.retryAfterSeconds ? ` Retry after ${error.retryAfterSeconds}s` : ""}`;
  }
  if (error instanceof GtApiError) {
    return `${error.message}${error.status ? ` (${error.status})` : ""}`;
  }
  return error instanceof Error ? error.message : "unknown error";
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
