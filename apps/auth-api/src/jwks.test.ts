import { describe, expect, it } from "vitest";
import { decodeJwt } from "./jwks";

const HEADER = "eyJhbGciOiJSUzI1NiJ9";
const PAYLOAD = "e30";

describe("decodeJwt", () => {
  it.each([
    "a+b",
    "a/b",
    "a b",
    "a",
  ])("returns invalid_token for malformed signature encoding %j", (signature) => {
    expect(() => decodeJwt(`${HEADER}.${PAYLOAD}.${signature}`)).toThrowError(
      expect.objectContaining({ code: "invalid_token", status: 401 }),
    );
  });

  it.each(["bnVsbA", "W10"])("returns invalid_token for non-object JSON %j", (segment) => {
    expect.assertions(1);
    try {
      decodeJwt(`${HEADER}.${segment}.AQIDBA`);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_token", status: 401 });
    }
  });

  it("decodes a valid unpadded base64url signature", () => {
    expect(decodeJwt(`${HEADER}.${PAYLOAD}.AQIDBA`).signature).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });
});
