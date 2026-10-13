import { NavLink } from "react-router-dom";

const tabs = [
  { to: "/library/all", label: "All" },
  { to: "/library", label: "This PC", end: true },
  { to: "/library/cloud", label: "Cloud" },
  { to: "/library/screenshots", label: "Screenshots" },
  { to: "/library/folders", label: "Folders" },
  { to: "/library/favorites", label: "Favorites" },
];

export function LibraryTabs() {
  return (
    <nav className="tabs library-tabs" aria-label="Library view">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? "active" : undefined)}>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
