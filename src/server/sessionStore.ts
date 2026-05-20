import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const COOKIE_NAME = "gt_agent_sid";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type AgentSession = {
  id: string;
  gtApiKey: string;
  createdAt: number;
  updatedAt: number;
};

export class SessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  save(reply: FastifyReply, gtApiKey: string): AgentSession {
    const now = Date.now();
    const id = crypto.randomUUID();
    const session: AgentSession = { id, gtApiKey, createdAt: now, updatedAt: now };
    this.sessions.set(id, session);
    reply.setCookie(COOKIE_NAME, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000)
    });
    this.prune(now);
    return session;
  }

  get(request: FastifyRequest): AgentSession | undefined {
    const id = request.cookies[COOKIE_NAME];
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    session.updatedAt = Date.now();
    return session;
  }

  clear(request: FastifyRequest, reply: FastifyReply): void {
    const id = request.cookies[COOKIE_NAME];
    if (id) this.sessions.delete(id);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
  }

  private prune(now: number): void {
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > SESSION_TTL_MS) this.sessions.delete(id);
    }
  }
}
