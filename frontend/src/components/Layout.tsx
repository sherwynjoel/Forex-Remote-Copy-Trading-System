import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/masters", label: "Masters" },
  { to: "/slaves", label: "Slaves" },
  { to: "/trades", label: "Live Trades" },
];

export function Layout() {
  const { logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-6 px-2 text-sm font-semibold tracking-wide text-slate-100">
          Forex Copy Trading
          <div className="text-xs font-normal text-slate-500">Super Admin</div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded px-2 py-1.5 text-sm ${isActive ? "bg-slate-800 text-slate-50" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={logout}
          className="mt-8 w-full rounded px-2 py-1.5 text-left text-sm text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
        >
          Log out
        </button>
      </aside>
      <main className="flex-1 overflow-x-hidden p-6">
        <Outlet />
      </main>
    </div>
  );
}
