import { describe, expect, it } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { normalizePrivateKey } from "../src/agent/github-app";

const TEST_RSA_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAq/nz0dYSJjkTK86qeFtX5RKtLgE2eHucS8K0NmiHZyugs3j1
fWUf0IiFZsFAY0/yCpvOZ9RRecmX+CO06L5QTNRPqeRG/eyjAmC1YEyA7ZTnMVe4
HvkbN1GMkFJuhjznO0UJ55fxfV9pCAiInUXP+uoXKeoCnC29c07UYHZeP+kR3PTI
RTPFX33DUMx1gXYvxksFmreAkbn8Qi9IXve3gtUYrWXydfpc+6NEQBxiSTns0O7p
iDcCOYYBgCEVOcvZ8tM4bpPt81Yp1tzKglURIpUeA/S6qoQAH/hAVU2qmYfnl6U+
m7hAlSwXPGXfxdqvKbUQnPFGyX6QD0Lj5qjmEwIDAQABAoIBACAF+bBjr9p9O0Qn
hhfGTo4h1ayg3i8+OULkPSF6gmgkOBbjWbchWvS+TzTsnFxB2Ty/eYZdA1TtxIYY
xAmo0pQT3sewccW7yDjboDqP1FwpI4nNH0RpN3esEEQZjWoish4Xw3nkEbw6RXkQ
+btrcghziZ+s6xKA8+uiTKqvr+ovYnjK3xnOGG/9sbPhxd69BqGwzTYzo3q+TjWQ
ft+Pk66Qwn154CmwZI94I7GEg/T6EAwy7EfnnBcjQ4jqn8AiPJgV6StOT3E0C3Sd
7P10vkJwbiWyikJ3htg0ZoOzZwpzwqeVE24EsunooyrdwUOI/zRdJ0jg1Gr58vK3
QMS5QuECgYEA3bH7sRpe3v4ojuV6Bvq2VpWK4JAgIY0zMcGI22yGJKwesHUjLx+o
CUHjO1qSFroyVu55RTgly+TwDvFWO8A1XCOuMePrAZ5BJEA1/kwAmRPJ5sSx/umi
MOxHWnKf53vbFQAPH52bDnazCq3cE3DLTtBXMQ1P6AcohC0JjLYIcLMCgYEAxpZ0
ePCtelqzfrWy1DcJaLbstADpzH3gOt8pCzjFpYw46wKU+1Xj8BBfdgTNjMHY8Plr
jVMvSKDPlG10pis58awPPCfjJtlbSG4gFn8QmhnAKKeOrFWzmYahmcmB5JllA5wM
v8NM+UHMTAjvAyavAsKwChT7g99fNGivpN7VpSECgYEAiPbR4cvB+xCYrBfX+QHh
rsJ651wDjdb3XvELhUyZ34Q6/ZeQ4iczoGyFX4EIKmRkf1Kbt4kFyN8q9IBjX0zT
apZco1QFN5227xeAhBgecnRIU3sH4M4ktwby2k1gvxnE80dzEHxFdH0fBiT9h0Ez
SgDrLVHlIRtzC53rfXRk6IMCgYBr7N61z49oPJzqUxMyNAsABtITbZ+ijBJtzFRB
DgSUWOWiCxAum9o54JwQxsFzKvKc2+CwuLGs1gCaWPYZTMq75deNyNuxhFUQwxDb
SQkbxrzhG1b1n8nwuPNgYdwfAaKdWJSxLxHJMRI3jG9hFgftByOnBwo9/AqAsBgt
ERGpIQKBgHe/ExPKv+I/rcvQiSLsXyjGfGgW6KWQlDhBLdluOazyYNotK9tTLmxH
QStmzLkUuCgkzee1WYxgAFOY/yC/INLSzXZJTptRKilxdsc5auxD3WZeGTXEmWCU
YAmh26aTPoD898cborwPAfNQ8bP3iEG22xQ5L1Ng5j/nDN8IChpX
-----END RSA PRIVATE KEY-----`;

describe("GitHub App key compatibility", () => {
  it("imports and signs with the RSA PKCS#1 PEM GitHub downloads", async () => {
    const key = await importPKCS8(normalizePrivateKey(TEST_RSA_PRIVATE_KEY), "RS256");
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("123")
      .sign(key);

    expect(jwt.split(".")).toHaveLength(3);
  });
});
