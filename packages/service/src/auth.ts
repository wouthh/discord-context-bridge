import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "./config.js";
import { BridgeError, type Principal } from "../../domain/src/index.js";
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function authenticator(config: Config, key?: JWTVerifyGetKey) {
  const jwks =
    config.auth.mode === "jwt"
      ? (key ??
        createRemoteJWKSet(new URL(config.auth.jwksUrl), {
          timeoutDuration: 5000,
        }))
      : undefined;
  return async (
    token: string,
    role: "reader" | "producer",
  ): Promise<Principal> => {
    try {
      const a = config.auth;
      let g;
      let expiresAt: number | undefined;
      if (a.mode === "local") {
        const hash = Buffer.from(tokenHash(token), "hex");
        g = a.credentials.find(
          (v) =>
            v.role === role &&
            v.expiresAt > Date.now() / 1000 &&
            timingSafeEqual(hash, Buffer.from(v.tokenHash, "hex")),
        );
        expiresAt = g?.expiresAt;
      } else {
        const { payload } = await jwtVerify(token, jwks!, {
          issuer: a.issuer,
          audience: role === "reader" ? a.readerAudience : a.producerAudience,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["exp", "sub", "iat"],
          maxTokenAge: "1h",
        });
        expiresAt = payload.exp;
        const scope = role === "reader" ? "bridge:read" : "bridge:ingest";
        if (
          typeof payload.scope !== "string" ||
          !payload.scope.split(" ").includes(scope)
        )
          throw new Error();
        g = a.grants.find((v) => v.role === role && v.subject === payload.sub);
      }
      if (!g) throw new Error();
      return {
        subject: g.subject,
        role: g.role,
        ownerId: config.ownerId,
        expiresAt,
        sourceIds: g.sourceIds,
        conversationIds: g.conversationIds,
      };
    } catch {
      throw new BridgeError("unauthorized", 401);
    }
  };
}
