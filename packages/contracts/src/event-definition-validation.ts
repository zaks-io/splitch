import type { z } from "zod";

const directPiiNames = new Set([
  "email",
  "emailaddress",
  "name",
  "fullname",
  "firstname",
  "lastname",
  "phone",
  "phonenumber",
  "address",
  "streetaddress",
  "ip",
  "ipaddress",
  "useragent",
  "cookie",
  "token",
  "ssn",
  "socialsecuritynumber",
  "taxid",
  "passportnumber",
  "driverslicensenumber",
  "nationalid",
  "governmentid",
  "userid",
  "customerid",
  "accountid",
  "bankaccountnumber",
  "creditcardnumber",
  "cardnumber",
  "routingnumber",
  "postalcode",
  "zipcode",
  "dateofbirth",
  "birthdate",
  "dob",
  "deviceid",
  "sessionid",
  "targetingkey",
]);

export function validatePropertyNames(
  names: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  for (const name of names) {
    const normalized = name.toLowerCase().replace(/[_.\- ]/g, "");
    if (directPiiNames.has(normalized)) {
      context.addIssue({
        code: "custom",
        path: [...path, name],
        message: "direct-PII property names are prohibited",
      });
    }
  }
}

export function validateNumericDomain(
  value: { allowedValues?: number[]; minimum?: number; maximum?: number },
  context: z.RefinementCtx,
): void {
  const allowlist = value.allowedValues !== undefined;
  const range = value.minimum !== undefined || value.maximum !== undefined;
  if (allowlist && range)
    context.addIssue({
      code: "custom",
      message: "number cannot combine an allowlist and bounded range",
    });
  if (range && (value.minimum === undefined || value.maximum === undefined)) {
    context.addIssue({ code: "custom", message: "minimum and maximum must be supplied together" });
  }
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
    context.addIssue({ code: "custom", message: "minimum must not exceed maximum" });
  }
}
