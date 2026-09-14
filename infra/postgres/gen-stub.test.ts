import { describe, it, expect } from "vitest";
import { prismaTypeToPg, extractModelsForSchema, renderCreateTable } from "./gen-stub";

describe("gen-stub", () => {
  it("maps prisma scalar types to postgres", () => {
    expect(prismaTypeToPg("String")).toBe("text");
    expect(prismaTypeToPg("Int")).toBe("integer");
    expect(prismaTypeToPg("BigInt")).toBe("bigint");
    expect(prismaTypeToPg("Decimal")).toBe("numeric");
    expect(prismaTypeToPg("Boolean")).toBe("boolean");
    expect(prismaTypeToPg("DateTime")).toBe("timestamp");
    expect(prismaTypeToPg("Json")).toBe("jsonb");
    expect(prismaTypeToPg("Bytes")).toBe("bytea");
  });

  it("extracts views mapped to a schema and renders tables", () => {
    const schema = `
view b3Proposals {
  proposal_id String @id
  proposer    String?
  start_block Decimal? @db.Decimal
  @@map("proposals_v2")
  @@schema("b3")
}
model Other {
  id Int @id
  @@schema("agora")
}
`;
    const models = extractModelsForSchema(schema, "b3");
    expect(models).toHaveLength(1);
    expect(models[0].table).toBe("proposals_v2");
    const sql = renderCreateTable(models[0], "fleet");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "fleet"."proposals_v2"');
    expect(sql).toContain('"proposal_id" text');
    expect(sql).toContain('"start_block" numeric');
  });
});
