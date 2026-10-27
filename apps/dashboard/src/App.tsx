import { Suspense } from "react";
import { Route, Routes, useLocation } from "react-router";
import { RequireMember, FullPageSpinner } from "./app/RequireMember";
import { ToastProvider } from "./app/Toasts";
import { ChunkErrorBoundary } from "./app/ChunkErrorBoundary";
import { lazyScreen } from "./app/screens";

// Every screen is its own chunk (route-level code splitting), and so is the
// signed-in shell: the public screens never download the navigation.
const SignIn = lazyScreen("SignIn");
const Join = lazyScreen("Join");
const Reset = lazyScreen("Reset");
const Mfa = lazyScreen("Mfa");
const Layout = lazyScreen("Layout");
const Overview = lazyScreen("Overview");
const Devices = lazyScreen("Devices");
const DeviceDetail = lazyScreen("DeviceDetail");
const Groups = lazyScreen("Groups");
const GroupDetail = lazyScreen("GroupDetail");
const Employees = lazyScreen("Employees");
const EmployeeDetail = lazyScreen("EmployeeDetail");
const Apps = lazyScreen("Apps");
const AppEdit = lazyScreen("AppEdit");
const FileTypes = lazyScreen("FileTypes");
const Enrollment = lazyScreen("Enrollment");
const Audit = lazyScreen("Audit");
const Settings = lazyScreen("Settings");
const Gallery = lazyScreen("Gallery");
const NotFound = lazyScreen("NotFound");

/** Routes of plan Section 4.13 (react-router declarative mode). */
export function App() {
  const { pathname } = useLocation();
  return (
    <ToastProvider>
      <ChunkErrorBoundary fullPage resetKey={pathname}>
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
      </ChunkErrorBoundary>
    </ToastProvider>
  );
}
