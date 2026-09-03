import { describe, expect, it } from "vitest";
import { decodeJwt } from "./jwks";

describe("decodeJwt", () => {
  it("returns invalid_token for malformed signature encoding", () => {
    expect.assertions(1);
    try {
      decodeJwt("eyJhbGciOiJSUzI1NiJ9.e30.%%%");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_token", status: 401 });
    }
  });
});
