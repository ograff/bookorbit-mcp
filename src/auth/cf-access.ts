import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface CfAccessOptions {
  /** "myteam" or "myteam.cloudflareaccess.com". */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  /** Injectable for tests; defaults to the team's remote JWKS (cached by jose). */
  getKey?: JWTVerifyGetKey;
}

export function normalizeTeamDomain(raw: string): string {
  const host = raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return host.includes(".") ? host : `${host}.cloudflareaccess.com`;
}

export interface CfIdentity {
  email?: string;
  sub?: string;
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header: signature (team JWKS), issuer, audience, expiry.
 * Returns the identity on success, throws with a short reason otherwise.
 */
export function createCfAccessVerifier(opts: CfAccessOptions) {
  const host = normalizeTeamDomain(opts.teamDomain);
  const issuer = `https://${host}`;
  const getKey =
    opts.getKey ??
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cooldownDuration: 30_000,
    });

  return async function verify(token: string | undefined): Promise<CfIdentity> {
    if (!token) throw new Error("missing Cf-Access-Jwt-Assertion header");
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer,
        audience: opts.aud,
        algorithms: ["RS256"],
      });
      return { email: payload.email as string | undefined, sub: payload.sub };
    } catch (err) {
      throw new Error(
        `invalid Cloudflare Access token: ${err instanceof Error ? err.message : err}`,
        { cause: err },
      );
    }
  };
}

export type CfAccessVerifier = ReturnType<typeof createCfAccessVerifier>;
