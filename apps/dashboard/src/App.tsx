import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { RequireMember, FullPageSpinner } from "./app/RequireMember";
import { Layout } from "./app/Layout";
import { ToastProvider } from "./app/Toasts";

// Every screen is its own chunk (route-level code splitting).
const SignIn = lazy(() => import("./screens/SignIn"));
const Join = lazy(() => import("./screens/Join"));
const Reset = lazy(() => import("./screens/Reset"));
const Mfa = lazy(() => import("./screens/Mfa"));
const Overview = lazy(() => import("./screens/Overview"));
const Devices = lazy(() => import("./screens/Devices"));
const DeviceDetail = lazy(() => import("./screens/DeviceDetail"));
const Groups = lazy(() => import("./screens/Groups"));
const GroupDetail = lazy(() => import("./screens/GroupDetail"));
const Employees = lazy(() => import("./screens/Employees"));
const EmployeeDetail = lazy(() => import("./screens/EmployeeDetail"));
const Apps = lazy(() => import("./screens/Apps"));
const AppEdit = lazy(() => import("./screens/AppEdit"));
const FileTypes = lazy(() => import("./screens/FileTypes"));
const Enrollment = lazy(() => import("./screens/Enrollment"));
const Audit = lazy(() => import("./screens/Audit"));
const Settings = lazy(() => import("./screens/Settings"));
const Gallery = lazy(() => import("./Gallery"));
const NotFound = lazy(() => import("./screens/NotFound"));

/** Routes of plan Section 4.13 (react-router declarative mode). */
export function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/join" element={<Join />} />
          <Route path="/reset" element={<Reset />} />
          <Route path="/mfa" element={<Mfa />} />
          <Route element={<RequireMember />}>
            <Route element={<Layout />}>
              <Route index element={<Overview />} />
              <Route path="devices" element={<Devices />} />
              <Route path="devices/:id" element={<DeviceDetail />} />
              <Route path="groups" element={<Groups />} />
              <Route path="groups/:id" element={<GroupDetail />} />
              <Route path="employees" element={<Employees />} />
              <Route path="employees/new" element={<EmployeeDetail />} />
              <Route path="employees/:id" element={<EmployeeDetail />} />
              <Route path="apps" element={<Apps />} />
              <Route path="apps/new" element={<AppEdit />} />
              <Route path="apps/:id" element={<AppEdit />} />
              <Route path="file-types" element={<FileTypes />} />
              <Route path="enrollment" element={<Enrollment />} />
              <Route path="audit" element={<Audit />} />
              <Route path="settings" element={<Settings />} />
              <Route path="gallery" element={<Gallery />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}
