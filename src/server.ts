#!/usr/bin/env node
import { createCfAccessVerifier } from "./auth/cf-access.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createClient } from "./server-factory.js";

const config = loadConfig();
const verifier = config.requireCfAccess
  ? createCfAccessVerifier({
      teamDomain: config.cfAccessTeamDomain!,
      aud: config.cfAccessAud!,
    })
  : undefined;

const server = createHttpServer({
  config,
  client: createClient(config),
  verifier,
  log: (m) => console.log(`${new Date().toISOString()} ${m}`),
});

server.listen(config.port, () => {
  console.log(
    `bookorbit-mcp listening on :${config.port} ` +
      `(cf-access ${config.requireCfAccess ? "required" : "OFF"}, ` +
      `destructive ${config.enableDestructive ? "enabled" : "disabled"})`,
  );
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
