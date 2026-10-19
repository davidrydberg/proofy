// Generates schema/proofy.schema.json from the config schema in src/config.ts, the one source of truth.
import { mkdirSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import { z } from "zod";
import { configSchema, SCHEMA_URL } from "../dist/config.js";

const schema = { ...z.toJSONSchema(configSchema, { io: "input" }), $id: SCHEMA_URL, title: "proofy config" };
mkdirSync(new URL("../schema/", import.meta.url), { recursive: true });
writeFileSync(new URL("../schema/proofy.schema.json", import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
