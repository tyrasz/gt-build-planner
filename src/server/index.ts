import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  basePlanWriteRequestSchema,
  buildPlanRequestSchema,
  sessionKeysRequestSchema,
  wishlistWriteRequestSchema,
  type BasePlanWriteResult,
  type WishlistWriteResult
} from "../shared/schemas.js";
import { GalacticTycoonsClient, GtApiError, RateLimitError, describeGtError } from "./gtClient.js";
import { buildBuildPlan } from "../shared/planner.js";
import { redactError } from "./redact.js";
import { SessionStore } from "./sessionStore.js";

export type CreateAppOptions = {
  gtClient?: GalacticTycoonsClient;
  sessions?: SessionStore;
};

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  const sessions = options.sessions ?? new SessionStore();
  const gtClient = options.gtClient ?? new GalacticTycoonsClient();

  await app.register(cookie);
  await app.register(cors, { origin: true, credentials: true });

  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/session/keys", async (request, reply) => {
    const parsed = sessionKeysRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid session keys.", details: parsed.error.format() });
    }
    const session = sessions.save(reply, parsed.data.gtApiKey);
    return {
      ok: true,
      session: {
        id: session.id,
        createdAt: new Date(session.createdAt).toISOString()
      }
    };
  });

  app.get("/api/session/status", async (request) => {
    const session = sessions.get(request);
    return { authenticated: Boolean(session) };
  });

  app.delete("/api/session", async (request, reply) => {
    sessions.clear(request, reply);
    return { ok: true };
  });

  app.post("/api/agent/build-plan", async (request, reply) => {
    const session = sessions.get(request);
    if (!session) return reply.code(401).send({ error: "No active GT Agent session." });

    const parsed = buildPlanRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid build-plan request.", details: parsed.error.format() });
    }

    try {
      const snapshot = await gtClient.getSnapshot(session);
      return buildBuildPlan(snapshot, parsed.data);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return reply.code(429).send({
          error: error.message,
          details: { endpoint: error.endpoint, retryAfterSeconds: error.retryAfterSeconds }
        });
      }
      if (error instanceof GtApiError) {
        const statusCode = error.status === 401 || error.status === 403 ? 401 : 502;
        return reply.code(statusCode).send({
          error: error.message,
          details: { endpoint: error.endpoint, status: error.status }
        });
      }
      request.log.error({ error: redactError(error) }, "build planning failed");
      return reply.code(500).send({ error: "Could not generate build plan." });
    }
  });

  app.post("/api/agent/wishlist", async (request, reply) => {
    const session = sessions.get(request);
    if (!session) return reply.code(401).send({ error: "No active GT Agent session." });

    const parsed = wishlistWriteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid wishlist request.", details: parsed.error.format() });
    }

    const manual = (message: string, warnings: string[] = []): WishlistWriteResult => ({
      status: "manual_only",
      title: parsed.data.manifest.title,
      wishlistId: parsed.data.manifest.wishlistId,
      writeAttempted: parsed.data.confirmed,
      message,
      manifest: parsed.data.manifest,
      warnings
    });

    if (!parsed.data.confirmed) {
      return manual("Wishlist write needs explicit confirmation. Review the manifest, then confirm to send it to Galactic Tycoons.");
    }

    try {
      return await gtClient.writeWishlist(session, parsed.data.manifest);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return reply.code(429).send({
          error: error.message,
          details: { endpoint: error.endpoint, retryAfterSeconds: error.retryAfterSeconds }
        });
      }
      if (error instanceof GtApiError) {
        if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404) {
          return manual(
            "Could not write the wishlist with this GT API key or endpoint. Use the manual manifest below.",
            [describeGtError(error)]
          );
        }
        return reply.code(502).send({ error: error.message, details: { endpoint: error.endpoint, status: error.status } });
      }
      request.log.error({ error: redactError(error) }, "wishlist write failed");
      return manual("Could not write the wishlist. Use the manual manifest below.", [redactError(error)]);
    }
  });

  app.post("/api/agent/base-plan", async (request, reply) => {
    const session = sessions.get(request);
    if (!session) return reply.code(401).send({ error: "No active GT Agent session." });

    const parsed = basePlanWriteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid base-plan request.", details: parsed.error.format() });
    }

    const manual = (message: string, warnings: string[] = []): BasePlanWriteResult => ({
      status: "manual_only",
      planId: parsed.data.draft.id,
      writeAttempted: parsed.data.confirmed,
      message,
      draft: parsed.data.draft,
      warnings
    });

    if (!parsed.data.confirmed) {
      return manual("Base-plan write needs explicit confirmation. Review the draft, then confirm to send it to Galactic Tycoons.");
    }

    try {
      return await gtClient.writeBasePlan(session, parsed.data.draft);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return reply.code(429).send({
          error: error.message,
          details: { endpoint: error.endpoint, retryAfterSeconds: error.retryAfterSeconds }
        });
      }
      if (error instanceof GtApiError) {
        if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404) {
          return manual(
            "Could not write the base plan with this GT API key or endpoint. Use the manual draft below.",
            [describeGtError(error)]
          );
        }
        return reply.code(502).send({ error: error.message, details: { endpoint: error.endpoint, status: error.status } });
      }
      request.log.error({ error: redactError(error) }, "base-plan write failed");
      return manual("Could not write the base plan. Use the manual draft below.", [redactError(error)]);
    }
  });

  const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client");
  if (process.env.NODE_ENV === "production") {
    await app.register(fastifyStatic, { root: clientDir });
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile("index.html");
    });
  }

  return app;
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? process.env.GT_AGENT_PORT ?? 8787);
  const app = await createApp();
  await app.listen({ host: "127.0.0.1", port });
}
