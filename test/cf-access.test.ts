import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { createCfAccessVerifier, normalizeTeamDomain } from "../src/auth/cf-access.js";

const TEAM = "acme";
const ISS = "https://acme.cloudflareaccess.com";
const AUD = "aud-tag-123";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid: "k1" };
  const verify = createCfAccessVerifier({
    teamDomain: TEAM,
    aud: AUD,
    getKey: createLocalJWKSet({ keys: [jwk] }),
  });
  const sign = (
    over: {
      iss?: string;
      aud?: string;
      exp?: string | number;
      key?: CryptoKey;
      kid?: string;
    } = {},
  ) =>
    new SignJWT({ email: "me@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: over.kid ?? "k1" })
      .setIssuer(over.iss ?? ISS)
      .setAudience(over.aud ?? AUD)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime(over.exp ?? "5m")
      .sign(over.key ?? privateKey);
  return { verify, sign };
}

test("normalizeTeamDomain accepts a bare team, a hostname, or a URL", () => {
  assert.equal(normalizeTeamDomain("acme"), "acme.cloudflareaccess.com");
  assert.equal(
    normalizeTeamDomain("acme.cloudflareaccess.com"),
    "acme.cloudflareaccess.com",
  );
  assert.equal(
    normalizeTeamDomain("https://acme.cloudflareaccess.com/"),
    "acme.cloudflareaccess.com",
  );
});

test("a valid token yields the identity", async () => {
  const { verify, sign } = await setup();
  assert.deepEqual(await verify(await sign()), {
    email: "me@example.com",
    sub: "user-1",
  });
});

test("missing header is rejected", async () => {
  const { verify } = await setup();
  await assert.rejects(verify(undefined), /missing/);
});

test("wrong audience, issuer and expired tokens are rejected", async () => {
  const { verify, sign } = await setup();
  await assert.rejects(
    verify(await sign({ aud: "other" })),
    /invalid Cloudflare Access token/,
  );
  await assert.rejects(
    verify(await sign({ iss: "https://evil.cloudflareaccess.com" })),
    /invalid/,
  );
  await assert.rejects(
    verify(await sign({ exp: Math.floor(Date.now() / 1000) - 60 })),
    /invalid/,
  );
});

test("a token signed by an unknown key is rejected", async () => {
  const { verify, sign } = await setup();
  const other = await generateKeyPair("RS256");
  await assert.rejects(verify(await sign({ key: other.privateKey })), /invalid/);
});

test("garbage and unsigned tokens are rejected", async () => {
  const { verify } = await setup();
  await assert.rejects(verify("not.a.jwt"), /invalid/);
  const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`;
  await assert.rejects(verify(unsigned), /invalid/);
});
