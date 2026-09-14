import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type PgField = {
  column: string;
  pgType: string;
  nullable: boolean;
};

export type StubModel = {
  name: string;
  table: string;
  fields: PgField[];
};

const SCALAR_TYPE_MAP: Record<string, string> = {
  String: "text",
  Int: "integer",
  BigInt: "bigint",
  Decimal: "numeric",
  Boolean: "boolean",
  DateTime: "timestamp",
  Json: "jsonb",
  Bytes: "bytea",
  Float: "double precision",
};

/**
 * Maps a Prisma scalar type name to a Postgres column type. Anything this
 * generator does not recognize (an enum other than DaoSlug, for example)
 * falls back to "text": these tables are empty stubs for reads, so an exact
 * type match only matters where Agora Next actually filters on the column.
 */
export function prismaTypeToPg(prismaType: string): string {
  return SCALAR_TYPE_MAP[prismaType] ?? "text";
}

type SchemaBlock = {
  kind: "model" | "view";
  name: string;
  body: string;
};

/**
 * Splits the schema.prisma text into its top-level model/view blocks. The
 * file only ever closes a block with a "}" alone on its own line (no field
 * default uses a brace), so tracking that is enough to find each block's
 * extent without a full Prisma parser.
 */
function splitIntoBlocks(text: string): SchemaBlock[] {
  const lines = text.split("\n");
  const blocks: SchemaBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines[i].match(/^(model|view)\s+(\w+)\s*\{\s*$/);
    if (start) {
      const kind = start[1] as "model" | "view";
      const name = start[2];
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "}") {
        bodyLines.push(lines[i]);
        i++;
      }
      blocks.push({ kind, name, body: bodyLines.join("\n") });
    }
    i++;
  }
  return blocks;
}

/** Every model/view name declared anywhere in the schema, used to tell a
 * relation field (whose type is another model) apart from a scalar field. */
function collectDeclaredTypeNames(text: string): Set<string> {
  const names = new Set<string>();
  const re = /^(?:model|view)\s+(\w+)\s*\{\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    names.add(match[1]);
  }
  return names;
}

const FIELD_LINE_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?(.*)$/;

/**
 * Parses one field's fields out of a model/view body, skipping relation
 * fields (their type is another model/view name, or they carry @relation).
 */
function extractFields(body: string, declaredTypes: Set<string>): PgField[] {
  const fields: PgField[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line || line.startsWith("@@")) continue;

    const fieldMatch = line.match(FIELD_LINE_RE);
    if (!fieldMatch) continue;

    const [, fieldName, baseType, arrayMark, optionalMark, rest] = fieldMatch;
    const isRelation = declaredTypes.has(baseType) || /@relation\(/.test(rest);
    if (isRelation) continue;

    const mapMatch = rest.match(/@map\("([^"]+)"\)/);
    const column = mapMatch ? mapMatch[1] : fieldName;

    let pgType = baseType === "DaoSlug" ? '"config"."dao_slug"' : prismaTypeToPg(baseType);
    if (arrayMark) pgType += "[]";

    fields.push({ column, pgType, nullable: Boolean(optionalMark) });
  }
  return fields;
}

/**
 * Returns the model/view blocks whose `@@schema("...")` matches schemaName,
 * with their fields resolved to Postgres columns.
 */
export function extractModelsForSchema(text: string, schemaName: string): StubModel[] {
  const declaredTypes = collectDeclaredTypeNames(text);
  const models: StubModel[] = [];

  for (const block of splitIntoBlocks(text)) {
    const schemaMatch = block.body.match(/@@schema\("([^"]+)"\)/);
    if (schemaMatch?.[1] !== schemaName) continue;

    const mapMatch = block.body.match(/@@map\("([^"]+)"\)/);
    const table = mapMatch ? mapMatch[1] : block.name;

    models.push({
      name: block.name,
      table,
      fields: extractFields(block.body, declaredTypes),
    });
  }

  return models;
}

/**
 * Renders a stub CREATE TABLE for a model in targetSchema. No constraints
 * (no primary key, no NOT NULL, no indexes): these tables only need to exist
 * and stay empty so Agora Next's Prisma reads return "no rows" instead of
 * failing on a missing relation.
 */
export function renderCreateTable(model: StubModel, targetSchema: string): string {
  const columns = model.fields.map((field) => `  "${field.column}" ${field.pgType}`).join(",\n");
  return `CREATE TABLE IF NOT EXISTS "${targetSchema}"."${model.table}" (\n${columns}\n);`;
}

/** Bare enum member names declared for `enum enumName { ... }` in the schema. */
function extractEnumValues(text: string, enumName: string): string[] {
  const re = new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const match = text.match(re);
  if (!match) {
    throw new Error(`enum ${enumName} not found in schema`);
  }

  const values: string[] = [];
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line || line.startsWith("@@")) continue;
    const valueMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (valueMatch) values.push(valueMatch[1]);
  }
  return values;
}

/** Idempotent CREATE TYPE for a Postgres enum (CREATE TYPE has no IF NOT EXISTS). */
function renderEnumCreate(schema: string, typeName: string, values: string[]): string {
  const valuesSql = values.map((value) => `'${value}'`).join(", ");
  return [
    "DO $$",
    "BEGIN",
    "  IF NOT EXISTS (",
    "    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace",
    `    WHERE t.typname = '${typeName}' AND n.nspname = '${schema}'`,
    "  ) THEN",
    `    CREATE TYPE "${schema}"."${typeName}" AS ENUM (${valuesSql});`,
    "  END IF;",
    "END$$;",
  ].join("\n");
}

function renderSchemaCreates(schemas: string[]): string {
  return schemas.map((schema) => `CREATE SCHEMA IF NOT EXISTS "${schema}";`).join("\n");
}

const GENERATED_HEADER =
  "-- Generated by infra/postgres/gen-stub.ts from vendor/agora-next/prisma/schema.prisma.\n-- Do not edit by hand: re-run the generator instead.";

function main(): void {
  const schemaPath = path.join(__dirname, "..", "..", "vendor", "agora-next", "prisma", "schema.prisma");
  const text = fs.readFileSync(schemaPath, "utf8");

  const b3Models = extractModelsForSchema(text, "b3");
  const agoraModels = extractModelsForSchema(text, "agora");
  const configModels = extractModelsForSchema(text, "config");
  const daoSlugValues = [...extractEnumValues(text, "DaoSlug"), "FLEET"];

  const web3Sql = [
    GENERATED_HEADER,
    "\\connect agora_web3",
    renderSchemaCreates(["fleet", "agora", "config"]),
    renderEnumCreate("config", "dao_slug", daoSlugValues),
    ...b3Models.map((model) => renderCreateTable(model, "fleet")),
    ...agoraModels.map((model) => renderCreateTable(model, "agora")),
    ...configModels.map((model) => renderCreateTable(model, "config")),
  ].join("\n\n") + "\n";

  // prismaWeb2Client and prismaWeb3Client in src/app/lib/prisma.ts are the
  // same PrismaClient instance backed by one DATABASE_URL, so Agora Next does
  // not actually split schemas across two databases today. agora_web2 gets
  // the same shared agora/config tables as agora_web3 (no fleet tables: the
  // fleet tenant's own data only needs to exist in agora_web3).
  const web2Sql = [
    GENERATED_HEADER,
    "-- prismaWeb2Client and prismaWeb3Client share one PrismaClient/DATABASE_URL",
    "-- (see vendor/agora-next/src/app/lib/prisma.ts), so agora_web2 mirrors the",
    "-- shared agora/config tables from agora_web3 instead of a distinct split.",
    "\\connect agora_web2",
    renderSchemaCreates(["agora", "config"]),
    renderEnumCreate("config", "dao_slug", daoSlugValues),
    ...agoraModels.map((model) => renderCreateTable(model, "agora")),
    ...configModels.map((model) => renderCreateTable(model, "config")),
  ].join("\n\n") + "\n";

  const outDir = path.join(__dirname, "init");
  fs.writeFileSync(path.join(outDir, "02-agora-stub.sql"), web3Sql);
  fs.writeFileSync(path.join(outDir, "03-agora-web2-stub.sql"), web2Sql);

  console.log(
    `Wrote ${b3Models.length} fleet table(s), ${agoraModels.length} agora table(s), ${configModels.length} config table(s) to infra/postgres/init/02-agora-stub.sql and infra/postgres/init/03-agora-web2-stub.sql.`
  );
}

if (process.argv[1] === __filename) {
  main();
}
