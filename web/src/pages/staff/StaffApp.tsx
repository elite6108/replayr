import { Navigate, Route, Routes } from "react-router-dom";
import { RequireStaff } from "../../components/RequireStaff";
import { StaffBoardPage } from "./StaffBoardPage";
import { StaffLayout } from "./StaffLayout";
import { StaffTasksPage } from "./StaffTasksPage";

export function StaffApp() {
  return (
    <Routes>
      <Route
        element={
          <RequireStaff>
            <StaffLayout />
          </RequireStaff>
        }
      >
        <Route index element={<Navigate to="/staff/board" replace />} />
        <Route path="board" element={<StaffBoardPage />} />
        <Route path="board/:boardId" element={<StaffBoardPage />} />
        <Route path="tasks" element={<StaffTasksPage />} />
      </Route>
    </Routes>
  );
}
