// Runs one small turn through the real `magpie` driver: Claude Code against the Magpie gateway on
// this computer, with no Claude account. It checks that the gateway answers, that the model list
// comes from the gateway, and that a turn on a non-Claude model gives a reply. It costs one short
// request on the user's gateway, so CI does not run it.
// `bun scripts/magpie-claude-live-e2e.ts [model]`. The default model is `auto/deepseek-v4.1-flash`.
// With no gateway it writes a skipped report and exits 0. Writes .openbot-build/magpie-claude-live-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { checkMagpieHealth, magpieGatewayOrigin } from "../src/backend/magpie";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";
import { runTurn, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/magpie-claude-live-e2e");
const MODEL = process.argv[2] ?? "auto/deepseek-v4.1-flash";

interface Report {
  skipped: boolean;
  origin: string;
  reason?: string;
  cli?: { version: string; source: string | null };
  provider?: string;
  models?: number;
  firstModel?: string | null;
  model?: string;
  reply?: string;
  status?: string | null;
}

function writeReport(report: Report): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

const origin = await Effect.runPromise(magpieGatewayOrigin());
const healthy = await Effect.runPromise(checkMagpieHealth((input, init) => fetch(input, init), origin));
if (!healthy) {
  writeReport({ skipped: true, reason: "No Magpie gateway answers.", origin });
  process.stdout.write(`SKIP magpie-claude-live-e2e: no gateway at ${origin}\n`);
  process.exit(0);
}

const driver = BUILT_IN_PROVIDER_DRIVERS.find((item) => item.id === "magpie");
assert.ok(driver, "no Magpie driver");
assert.equal(driver.cliProvider, "claude");

const root = await mkdtemp(join(tmpdir(), "openbot-magpie-live-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const cli = await Effect.runPromise(driver.resolveCli());
const client = driver.createClient(cli, 60_000, { ...NO_PROVIDER_CREDENTIALS, providerStateDirectory: root });
try {
  client.start();
  const account = await Effect.runPromise(client.request("account/read", {}, (value) => value));
  assert.deepEqual(account, { account: { type: "magpie", email: null, planType: null }, requiresOpenaiAuth: false });
  const list = await Effect.runPromise(client.request("model/list", {}, (value) => value));
  const ids = JSON.stringify(list).match(/"model":"[^"]+"/g) ?? [];
  assert.ok(
    ids.some((id) => id === `"model":"${MODEL}"`),
    `the gateway lists no ${MODEL}`,
  );
  const thread = await startThread(client, { cwd: workspace, model: MODEL });
  const turn = await runTurn(client, thread, {
    model: MODEL,
    text: "Reply with OK and nothing else.",
    timeoutMs: 120_000,
  });
  assert.equal(turn.status, "completed", turn.error ?? "the turn did not complete");
  assert.match(turn.reply, /\bOK\b/i);
  writeReport({
    skipped: false,
    origin,
    cli: { version: cli.version, source: cli.source ?? null },
    provider: client.provider,
    models: ids.length,
    firstModel: ids[0]?.slice(9, -1) ?? null,
    model: MODEL,
    reply: turn.reply,
    status: turn.status,
  });
  process.stdout.write(`PASS magpie-claude-live-e2e: ${JSON.stringify(turn.reply)} (${join(OUT, "report.json")})\n`);
} finally {
  await stopClients([client]);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
