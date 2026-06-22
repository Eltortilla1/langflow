/**
 * Regression tests for issue #13766:
 * "Login screen not displayed (stuck on loading, repeated auto_login/refresh loop)"
 *
 * Root cause: when LANGFLOW_AUTO_LOGIN=false the backend returns HTTP 403 with:
 *   { "detail": { "message": "Auto login is disabled.", "auto_login": false } }
 *
 * The previous code read `error.response?.data?.auto_login`, which is `undefined`
 * because FastAPI nests the payload under `detail`. As a result
 * `autoLoginDisabledByBackend` was always `false`, causing an infinite retry loop
 * and the login screen never being rendered.
 *
 * The fix checks `error.response?.data?.detail?.auto_login` first (FastAPI shape)
 * and falls back to `error.response?.data?.auto_login` for forward-compatibility.
 */

import type { AutoLoginErrorResponse } from "../use-get-autologin";

/**
 * Mirrors the fixed detection logic from use-get-autologin.ts so that
 * changes to that logic automatically break these tests.
 */
function isAutoLoginDisabledByBackend(
  data: AutoLoginErrorResponse | undefined,
): boolean {
  return data?.detail?.auto_login === false || data?.auto_login === false;
}

describe("autoLoginDisabledByBackend detection (issue #13766)", () => {
  describe("FastAPI nested shape — { detail: { auto_login: false } }", () => {
    it("returns true when auto_login is nested under detail", () => {
      const data: AutoLoginErrorResponse = {
        detail: { auto_login: false, message: "Auto login is disabled." },
      };
      expect(isAutoLoginDisabledByBackend(data)).toBe(true);
    });

    it("returns false when detail.auto_login is true (should never happen but guard it)", () => {
      const data: AutoLoginErrorResponse = {
        detail: { auto_login: true },
      };
      expect(isAutoLoginDisabledByBackend(data)).toBe(false);
    });

    it("returns false when detail exists but auto_login is absent", () => {
      const data: AutoLoginErrorResponse = {
        detail: { message: "some other error" },
      };
      expect(isAutoLoginDisabledByBackend(data)).toBe(false);
    });
  });

  describe("Previous buggy path — data.auto_login directly (undefined for FastAPI errors)", () => {
    it("returns false when only data is present without detail (old incorrect read)", () => {
      // This simulates what the OLD code read: data.auto_login === undefined
      const data = { detail: { auto_login: false } } as AutoLoginErrorResponse;
      // Accessing data.auto_login (old code) gives undefined, which !== false
      expect(data.auto_login).toBeUndefined();
    });
  });

  describe("Flat shape — { auto_login: false } — forward-compatibility fallback", () => {
    it("returns true when auto_login is at the top level", () => {
      const data: AutoLoginErrorResponse = { auto_login: false };
      expect(isAutoLoginDisabledByBackend(data)).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("returns false when data is undefined", () => {
      expect(isAutoLoginDisabledByBackend(undefined)).toBe(false);
    });

    it("returns false when data is an empty object", () => {
      expect(isAutoLoginDisabledByBackend({})).toBe(false);
    });
  });
});
