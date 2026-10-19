import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CliError } from "./errors.js";

export const SCHEMA_URL = "https://unpkg.com/@davidrydberg/proofy/schema/proofy.schema.json";

const name = z.string().min(1);
const command = z.array(z.string().min(1)).min(1).describe("Command and arguments, run without a shell");
const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/, "must be a lowercase hostname like api.stripe.com");

const serviceCommand = z.strictObject({ service: name.describe("Compose service to run it in"), command });

export const configSchema = z
  .strictObject({
    $schema: z.string().optional(),
    compose: z.array(name).default([]).describe("The app's compose files, relative to the repository root"),
    app: z
      .strictObject({
        service: name.describe("Compose service the browser opens"),
        port: z.number().int().min(1).max(65535).describe("Port inside the container, not a published port"),
        path: z.string().startsWith("/").default("/"),
      })
      .optional()
      .describe("Where the browser starts"),
    seed: serviceCommand.optional().describe("Runs once on the empty database before the tests"),
    exec: z.record(name, serviceCommand).default({}).describe("Commands tests may run with exec(name), such as a scheduled job"),
    hosts: z
      .record(hostname, z.enum(["fake", "record"]))
      .default({})
      .describe("Outside hosts: fake answers from e2e/standins/<host>.mjs, record accepts everything. Unlisted hosts are refused"),
    assets: z.array(z.url()).default([]).describe("Static third-party files downloaded at install and served in the sealed run"),
    env: z.record(name, z.record(name, z.string())).default({}).describe("Settings per compose service. The repository's .env is never read"),
    limits: z
      .strictObject({
        startMinutes: z.number().positive().default(10),
        testMinutes: z.number().positive().default(5),
        maxRunMinutes: z.number().positive().optional(),
        parallel: z.number().int().min(1).default(4),
      })
      .prefault({}),
  })
  .describe("proofy configuration, e2e/proofy.json");

export type Config = z.infer<typeof configSchema>;

export function parseConfig(raw: string, file: string): Config {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw invalid(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const result = configSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw invalid(`${file}: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return result.data;
}

export async function loadConfig(file: string, label: string): Promise<Config> {
  return parseConfig(await readFile(file, "utf8"), label);
}

function invalid(message: string): CliError {
  return new CliError(message, "CONFIG_INVALID", [`Fix it, then run \`proofy\` to check. Every field is described in ${SCHEMA_URL}`]);
}
