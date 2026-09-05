import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { StateAction } from "@microsoft/agent-host-protocol";
import { Codes, requireThat } from "./protocol/errors.js";

const schema = JSON.parse(
  readFileSync(
    new URL("../schema/upstream/ahp-actions.schema.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
const ajv = new Ajv2020({
  strict: false,
  allErrors: false,
  validateFormats: false,
});
ajv.addSchema(schema, "ahp");
// AHP 0.9.0's generated StateAction union contains a dangling #/$defs/
// reference. Compile its concrete, discriminated action definitions instead;
// keep the upstream file byte-identical and do not weaken field validation.
const definitions = schema.$defs as Record<
  string,
  { properties?: { type?: { const?: string } } }
>;
const concrete = Object.entries(definitions).filter(
  ([name, value]) =>
    name.endsWith("Action") &&
    typeof value.properties?.type?.const === "string",
);
const validate = ajv.compile({
  anyOf: concrete.map(([name]) => ({ $ref: `ahp#/$defs/${name}` })),
});
export function actionFrom(value: unknown): StateAction {
  requireThat(
    validate(value),
    Codes.invalid,
    `Invalid AHP action: ${ajv.errorsText(validate.errors)}`,
  );
  return value as StateAction;
}
