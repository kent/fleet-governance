import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { ActionDescriptor, DecisionKind } from "@fleet/schemas";
import {
  MalformedCalldataError,
  decodeRecordDecision,
  encodeRecordDecision,
  payloadHashForAction,
  payloadHashForCharter,
  payloadHashForPath,
  supportToUint8,
} from "./actions.js";

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;
const SAMPLE_HASH: Hex = `0x${"ab".repeat(32)}`;

const BASE_ACTION = {
  taskId: 7n,
  kind: "GRANT_EXCEPTION" as DecisionKind,
  expectedVersion: 1,
  payloadHash: SAMPLE_HASH,
  newCharterText: "",
  summary: "Grant a one-time exception to fetch reference tests.",
};

describe("encodeRecordDecision / decodeRecordDecision", () => {
  it("round trips every field through encode then decode", () => {
    const encoded = encodeRecordDecision(BASE_ACTION);
    const decoded = decodeRecordDecision(encoded);
    expect(decoded).toEqual(BASE_ACTION);
  });

  it("round trips an AMEND_CHARTER action carrying charter text", () => {
    const action = {
      taskId: 42n,
      kind: "AMEND_CHARTER" as DecisionKind,
      expectedVersion: 3,
      payloadHash: ZERO_HASH,
      newCharterText: '{"schema":"fleet.charter.v1"}',
      summary: "Tighten the allowlist.",
    };
    const encoded = encodeRecordDecision(action);
    const decoded = decodeRecordDecision(encoded);
    expect(decoded).toEqual(action);
  });

  it("round trips every DecisionKind (kind mapping is a bijection)", () => {
    const kinds: DecisionKind[] = [
      "CHOOSE_PATH",
      "GRANT_EXCEPTION",
      "AMEND_CHARTER",
      "STOP_TASK",
      "ESCALATE_TO_HUMAN",
    ];
    for (const kind of kinds) {
      const action = {
        ...BASE_ACTION,
        kind,
        newCharterText: kind === "AMEND_CHARTER" ? "some charter text" : "",
      };
      const decoded = decodeRecordDecision(encodeRecordDecision(action));
      expect(decoded.kind).toBe(kind);
    }
  });

  it("rejects calldata with a trailing byte appended", () => {
    const encoded = encodeRecordDecision(BASE_ACTION);
    const withTrailingByte = (encoded + "ff") as Hex;
    expect(() => decodeRecordDecision(withTrailingByte)).toThrow(MalformedCalldataError);
  });

  it("rejects calldata with the wrong selector", () => {
    const encoded = encodeRecordDecision(BASE_ACTION);
    // Flip the last selector byte so it no longer matches recordDecision's selector.
    const wrongSelector = (`0xffffffff${encoded.slice(10)}`) as Hex;
    expect(() => decodeRecordDecision(wrongSelector)).toThrow(MalformedCalldataError);
  });

  it("rejects calldata shorter than the 4-byte selector", () => {
    expect(() => decodeRecordDecision("0xaabb")).toThrow(MalformedCalldataError);
  });

  it("rejects calldata with the right selector but a truncated static head", () => {
    const encoded = encodeRecordDecision(BASE_ACTION);
    // Selector plus fewer than 6 words (192 bytes): 4 + 4*32 = 132 bytes -> 264 hex chars + '0x'.
    const truncated = encoded.slice(0, 2 + 264) as Hex;
    expect(() => decodeRecordDecision(truncated)).toThrow(MalformedCalldataError);
  });
});

describe("payloadHashForAction / payloadHashForCharter / payloadHashForPath", () => {
  it("hashes canonicalized bytes of an action descriptor", () => {
    const action: ActionDescriptor = {
      class: "network_fetch",
      target: "examples.internal",
      argsHash: ZERO_HASH,
    };
    const hash = payloadHashForAction(action);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Same logical value, different key order: canonicalization means the hash is identical.
    const reordered = {
      target: action.target,
      argsHash: action.argsHash,
      class: action.class,
    } as ActionDescriptor;
    expect(payloadHashForAction(reordered)).toBe(hash);
  });

  it("hashes raw charter text bytes directly, not canonicalized", () => {
    const text = '{"z":1,"a":2}';
    const hash = payloadHashForCharter(text);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Reordering the raw text's characters changes the hash, unlike payloadHashForAction.
    expect(payloadHashForCharter('{"a":2,"z":1}')).not.toBe(hash);
  });

  it("hashes canonicalized bytes of an arbitrary path descriptor", () => {
    const a = payloadHashForPath({ z: 1, a: 2 });
    const b = payloadHashForPath({ a: 2, z: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("supportToUint8", () => {
  it("maps AGAINST to 0, FOR to 1, ABSTAIN to 2", () => {
    expect(supportToUint8("AGAINST")).toBe(0);
    expect(supportToUint8("FOR")).toBe(1);
    expect(supportToUint8("ABSTAIN")).toBe(2);
  });
});
