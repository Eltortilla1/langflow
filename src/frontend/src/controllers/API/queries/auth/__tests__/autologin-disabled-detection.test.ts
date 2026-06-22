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
 */

// --- Mocks must be declared before imports (Jest hoisting) ---

const mockSetAutoLogin = jest.fn();
const mockGetUser = jest.fn();
let mockIsAuthenticated = false;
let mockAutoLogin: boolean | undefined = undefined;

jest.mock("@/stores/authStore", () => {
  type StoreState = {
    setAutoLogin: jest.Mock;
    isAuthenticated: boolean;
    autoLogin: boolean | undefined;
  };
  const store = (selector: (s: StoreState) => unknown) =>
    selector({
      setAutoLogin: mockSetAutoLogin,
      isAuthenticated: mockIsAuthenticated,
      autoLogin: mockAutoLogin,
    });
  store.getState = () => ({
    isAuthenticated: mockIsAuthenticated,
    autoLogin: mockAutoLogin,
  });
  return { __esModule: true, default: store };
});

jest.mock("@/contexts/authContext", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    AuthContext: React.createContext({
      login: jest.fn(),
      setUserData: jest.fn(),
      getUser: mockGetUser,
    }),
  };
});

jest.mock("@/controllers/API/api", () => ({
  api: { get: jest.fn() },
}));

jest.mock("@/controllers/API/helpers/constants", () => ({
  getURL: jest.fn((endpoint: string) => `/api/v1/${endpoint.toLowerCase()}`),
}));

jest.mock("@/controllers/API/services/request-processor", () => ({
  UseRequestProcessor: () => ({
    query: jest.fn((_key: string[], fn: () => Promise<null>) => ({
      data: null,
      isLoading: false,
      isFetched: true,
      refetch: fn,
    })),
  }),
}));

jest.mock("@/constants/constants", () => ({
  AUTO_LOGIN_MAX_RETRY_DELAY: 30000,
  AUTO_LOGIN_RETRY_DELAY: 1000,
  IS_AUTO_LOGIN: false,
}));

// --- Imports ---

import { renderHook } from "@testing-library/react";
import { api } from "@/controllers/API/api";
import {
  type AutoLoginErrorResponse,
  isAutoLoginDisabled,
  useGetAutoLogin,
} from "../use-get-autologin";

describe("isAutoLoginDisabled (issue #13766)", () => {
  describe("FastAPI nested shape — { detail: { auto_login: false } }", () => {
    it("returns true when auto_login is nested under detail", () => {
      const data: AutoLoginErrorResponse = {
        detail: { auto_login: false, message: "Auto login is disabled." },
      };
      expect(isAutoLoginDisabled(data)).toBe(true);
    });

    it("returns false when detail.auto_login is true", () => {
      const data: AutoLoginErrorResponse = {
        detail: { auto_login: true },
      };
      expect(isAutoLoginDisabled(data)).toBe(false);
    });

    it("returns false when detail exists but auto_login is absent", () => {
      const data: AutoLoginErrorResponse = {
        detail: { message: "some other error" },
      };
      expect(isAutoLoginDisabled(data)).toBe(false);
    });
  });

  describe("Previous buggy read — data.auto_login (undefined for FastAPI errors)", () => {
    it("data.auto_login is undefined when only detail is present, but isAutoLoginDisabled still returns true", () => {
      const data = {
        detail: { auto_login: false },
      } as AutoLoginErrorResponse;
      // The old code read data.auto_login directly — undefined, so it missed the signal
      expect(data.auto_login).toBeUndefined();
      // The fixed function reads data.detail.auto_login and correctly returns true
      expect(isAutoLoginDisabled(data)).toBe(true);
    });
  });

  describe("Flat shape — { auto_login: false } — forward-compatibility fallback", () => {
    it("returns true when auto_login is at the top level", () => {
      const data: AutoLoginErrorResponse = { auto_login: false };
      expect(isAutoLoginDisabled(data)).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("returns false when data is undefined", () => {
      expect(isAutoLoginDisabled(undefined)).toBe(false);
    });

    it("returns false when data is an empty object", () => {
      expect(isAutoLoginDisabled({})).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests: useGetAutoLogin hook — auto_login disabled detection
// ---------------------------------------------------------------------------

describe("useGetAutoLogin hook — auto_login disabled detection (issue #13766)", () => {
  const mockApiGet = api.get as jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockIsAuthenticated = false;
    mockAutoLogin = undefined;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  function makeAxiosError(data: AutoLoginErrorResponse) {
    const err = new Error("Request failed") as Error & {
      response: { data: AutoLoginErrorResponse };
    };
    err.name = "AxiosError";
    err.response = { data };
    return err;
  }

  it("FastAPI nested shape: sets autoLogin=false and does NOT schedule a retry", async () => {
    mockApiGet.mockRejectedValueOnce(
      makeAxiosError({
        detail: { auto_login: false, message: "Auto login is disabled." },
      }),
    );

    const { result } = renderHook(() => useGetAutoLogin({}));
    await (result.current as { refetch: () => Promise<null> }).refetch();

    expect(mockSetAutoLogin).toHaveBeenCalledWith(false);
    // No retry timer should fire
    jest.runAllTimers();
    expect(mockApiGet).toHaveBeenCalledTimes(1);
  });

  it("flat shape: sets autoLogin=false and does NOT schedule a retry", async () => {
    mockApiGet.mockRejectedValueOnce(makeAxiosError({ auto_login: false }));

    const { result } = renderHook(() => useGetAutoLogin({}));
    await (result.current as { refetch: () => Promise<null> }).refetch();

    expect(mockSetAutoLogin).toHaveBeenCalledWith(false);
    jest.runAllTimers();
    expect(mockApiGet).toHaveBeenCalledTimes(1);
  });

  it("generic error (no auto_login signal): sets autoLogin=false and schedules a retry", async () => {
    // Simulate auto-login mode so handleAutoLoginError schedules a retry
    mockAutoLogin = true;
    // First call fails with a generic error; second also fails to stop the loop
    mockApiGet
      .mockRejectedValueOnce(makeAxiosError({}))
      .mockRejectedValueOnce(makeAxiosError({}));

    const { result } = renderHook(() => useGetAutoLogin({}));
    await (result.current as { refetch: () => Promise<null> }).refetch();

    expect(mockSetAutoLogin).toHaveBeenCalledWith(false);
    // A retry timer should have been scheduled
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(mockApiGet).toHaveBeenCalledTimes(2);
  });
});
