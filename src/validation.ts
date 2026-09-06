import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
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
const definitionsByType = new Map<string, string[]>();
for (const [name, value] of concrete) {
  const type = value.properties!.type!.const!;
  definitionsByType.set(type, [...(definitionsByType.get(type) ?? []), name]);
}
const validators = new Map<string, ValidateFunction>();
export function actionFrom(value: unknown): StateAction {
  const type =
    value && typeof value === "object" && "type" in value ? value.type : null;
  const names = typeof type === "string" ? definitionsByType.get(type) : null;
  requireThat(names, Codes.invalid, "Invalid AHP action: unknown action type");
  const key = names.join(":");
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile({
      anyOf: names.map((name) => ({ $ref: `ahp#/$defs/${name}` })),
    });
    validators.set(key, validate);
  }
  requireThat(
    validate(value),
    Codes.invalid,
    `Invalid AHP action: ${ajv.errorsText(validate.errors)}`,
  );
  return value as StateAction;
}
