import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, clearToken, getToken, setToken, setUnauthorizedHandler } from "./api";

interface AuthContextValue {
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => getToken() !== null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A 401 from any request (expired/invalid token) logs the user out,
    // rather than leaving the UI stuck on stale data with silent failures.
    setUnauthorizedHandler(() => {
      clearToken();
      setIsAuthenticated(false);
    });
  }, []);

  async function login(username: string, password: string) {
    setLoading(true);
    setError(null);
    try {
      const { token } = await api.post<{ token: string }>("/api/auth/login", { username, password });
      setToken(token);
      setIsAuthenticated(true);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Invalid username or password" : "Login failed — is the backend running?");
      throw err;
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearToken();
    setIsAuthenticated(false);
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, loading, error, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
