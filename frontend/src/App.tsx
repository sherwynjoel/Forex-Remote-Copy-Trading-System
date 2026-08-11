import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { MastersPage } from "./pages/MastersPage";
import { MasterDetailPage } from "./pages/MasterDetailPage";
import { SlavesPage } from "./pages/SlavesPage";
import { SlaveDetailPage } from "./pages/SlaveDetailPage";
import { TradesPage } from "./pages/TradesPage";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/masters" element={<MastersPage />} />
        <Route path="/masters/:id" element={<MasterDetailPage />} />
        <Route path="/slaves" element={<SlavesPage />} />
        <Route path="/slaves/:id" element={<SlaveDetailPage />} />
        <Route path="/trades" element={<TradesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
