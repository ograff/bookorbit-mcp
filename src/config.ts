export interface AppConfig {
  bookorbitUrl: string;
  username: string;
  password: string;
  port: number;
  /** Reject requests lacking a valid Cloudflare Access JWT (HTTP transport only). */
  requireCfAccess: boolean;
  cfAccessTeamDomain?: string;
  cfAccessAud?: string;
  /** When false, every destructive action is refused, even with confirm: true. */
  enableDestructive: boolean;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/** Build config from the environment, failing fast on anything required but missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const bookorbitUrl = env.BOOKORBIT_URL?.trim();
  const username = env.BOOKORBIT_USERNAME?.trim();
  const password = env.BOOKORBIT_PASSWORD;
  if (!bookorbitUrl) throw new Error("BOOKORBIT_URL is required.");
  if (!username || !password) {
    throw new Error("BOOKORBIT_USERNAME and BOOKORBIT_PASSWORD are required.");
  }

  const requireCfAccess = flag(env.REQUIRE_CF_ACCESS, true);
  const cfAccessTeamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim() || undefined;
  const cfAccessAud = env.CF_ACCESS_AUD?.trim() || undefined;
  if (requireCfAccess && (!cfAccessTeamDomain || !cfAccessAud)) {
    throw new Error(
      "REQUIRE_CF_ACCESS is on: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, " +
        "or set REQUIRE_CF_ACCESS=false for local development.",
    );
  }

  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT is invalid.");

  return {
    bookorbitUrl,
    username,
    password,
    port,
    requireCfAccess,
    cfAccessTeamDomain,
    cfAccessAud,
    enableDestructive: flag(env.ENABLE_DESTRUCTIVE, true),
  };
}
