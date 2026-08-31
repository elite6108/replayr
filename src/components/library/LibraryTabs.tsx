import { NavLink } from "react-router-dom";

export function LibraryTabs() {
  return (
    <nav className="tabs" aria-label="Library view">
      <NavLink to="/library" end className={({ isActive }) => (isActive ? "active" : undefined)}>
        This PC
      </NavLink>
      <NavLink to="/library/cloud" className={({ isActive }) => (isActive ? "active" : undefined)}>
        Cloud
      </NavLink>
      <NavLink to="/library/folders" className={({ isActive }) => (isActive ? "active" : undefined)}>
        Folders
      </NavLink>
    </nav>
  );
}
