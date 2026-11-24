import { describe, expect, test } from "bun:test";
import { createGuardedClassifierFetch } from "./inbox-classification-model.ts";

const config = { provider: "openai-compatible", baseUrl: "https://provider.example/v1" };

describe("guarded classifier fetch (workerd redirect semantics)", () => {
  test("returns the normal response and never asks for redirect: error", async () => {
    const seen = [];
    const fetchImpl = async (request, init) => {
      seen.push({ url: request.url, redirect: init?.redirect });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const response = await createGuardedClassifierFetch(config, fetchImpl)(
      "https://provider.example/v1/chat/completions",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(200);
    // workerd only supports follow/manual; "error" throws before any network IO.
    expect(seen[0].redirect).toBe("manual");
    expect(seen[0].url).toBe("https://provider.example/v1/chat/completions");
  });

  test("rejects a redirect instead of following it, so the key is never forwarded", async () => {
    let followed = false;
    const fetchImpl = async () => {
      followed = true;
      return new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/steal" },
      });
    };

    await expect(
      createGuardedClassifierFetch(config, fetchImpl)(
        "https://provider.example/v1/chat/completions",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toMatchObject({ code: "ai_classification_target_denied" });
    expect(followed).toBe(true);
    // The redirect response is surfaced as an error, never returned to the SDK.
    // Only the allowed endpoint was ever contacted.
  });

  test("rejects an opaque redirect without exposing a response", async () => {
    const fetchImpl = async () => ({ type: "opaqueredirect", status: 0 });

    await expect(
      createGuardedClassifierFetch(config, fetchImpl)(
        "https://provider.example/v1/chat/completions",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toMatchObject({ code: "ai_classification_target_denied" });
  });

  test("refuses an endpoint outside the configured allowlist before any fetch", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };

    await expect(
      createGuardedClassifierFetch(config, fetchImpl)(
        "https://attacker.example/v1/chat/completions",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toMatchObject({ code: "ai_classification_target_denied" });
    expect(called).toBe(false);
  });
});
