import { Routes, Route } from "react-router-dom";
import AuthProvider from "./context/AuthProvider";
import ProtectedRoute from "./context/ProtectedRoute";
import TripProvider from "./context/TripProvider";
import NotificationProvider from "./context/NotificationProvider";
import SplashScreen from "./screens/auth/SplashScreen";
import LoginScreen from "./screens/auth/LoginScreen";
import RegisterScreen from "./screens/auth/RegisterScreen";
import ForgotPasswordScreen from "./screens/auth/ForgotPasswordScreen";
import ResetPasswordScreen from "./screens/auth/ResetPasswordScreen";
import StaffSignupScreen from "./screens/auth/StaffSignupScreen";
import AccountCreatedScreen from "./screens/auth/AccountCreatedScreen";
import CheckEmailScreen from "./screens/auth/CheckEmailScreen";
import NotFoundScreen from "./screens/NotFoundScreen";
import DashboardLayout from "./layout/DashboardLayout";
import StaffLayout from "./layout/StaffLayout";
import StaffCompleteSignupScreen from "./screens/auth/StaffCompleteSignupScreen";

// Commuter surfaces
import HomeScreen from "./screens/commuter/home/HomeScreen";
import TimetableScreen from "./screens/commuter/home/TimetableScreen";
import Route42Screen from "./screens/commuter/home/Route42Screen";
import SupportScreen from "./screens/commuter/home/SupportScreen";
import LoadtripsScreen from "./screens/commuter/LoadTrips/LoadtripsScreen";
import CardScreen from "./screens/commuter/Card/CardScreen";
import UseTicketScreen from "./screens/commuter/Card/UseTicketScreen";
import RideSuccessScreen from "./screens/commuter/Card/RideSuccessScreen";
import HistoryScreen from "./screens/commuter/History/HistoryScreen";
import TripScreen from "./screens/commuter/History/TripScreen";
import ProfileScreen from "./screens/commuter/Profile/ProfileScreen";
import UpdateProfileScreen from "./screens/commuter/Profile/UpdateProfileScreen";
import NotificationsScreen from "./screens/commuter/Notifications/NotificationsScreen";

// Staff console — shared + per-role (one folder per team lane)
import StaffHomeScreen from "./screens/staff/shared/StaffHomeScreen";
import OnboardingScreen from "./screens/staff/admin/OnboardingScreen";
import TeamScreen from "./screens/staff/admin/TeamScreen";
import AlertsScreen from "./screens/staff/admin/AlertsScreen";
import VerifyScreen from "./screens/staff/inspector/VerifyScreen";
import InspectionHistoryScreen from "./screens/staff/inspector/InspectionHistoryScreen";
import RunsScreen from "./screens/staff/driver/RunsScreen";
import InboxScreen from "./screens/staff/agent/InboxScreen";
import ChatScreen from "./screens/staff/agent/ChatScreen";
import KioskScreen from "./screens/staff/clerk/KioskScreen";
import ConcessionsScreen from "./screens/staff/clerk/ConcessionsScreen";
import StaffProfileScreen from "./screens/staff/shared/StaffProfileScreen";

const commuterTree = (
  <Route
    element={
      <ProtectedRoute>
        <TripProvider>
          <DashboardLayout />
        </TripProvider>
      </ProtectedRoute>
    }
  >
    <Route path="/home" element={<HomeScreen />} />
    <Route path="/timetable" element={<TimetableScreen />} />
    <Route path="/route-42" element={<Route42Screen />} />
    <Route path="/support" element={<SupportScreen />} />
    <Route path="/load-trips" element={<LoadtripsScreen />} />
    <Route path="/card" element={<CardScreen />} />
    <Route path="/use-ticket" element={<UseTicketScreen />} />
    <Route path="/ride-success" element={<RideSuccessScreen />} />
    <Route path="/history" element={<HistoryScreen />} />
    <Route path="/trip" element={<TripScreen />} />
    <Route path="/profile" element={<ProfileScreen />} />
    <Route path="/profile/update" element={<UpdateProfileScreen />} />
    <Route path="/notifications" element={<NotificationsScreen />} />
  </Route>
);

/**
 * Staff console — one layout, role-filtered nav. Each role folder in
 * screens/staff/<role>/ is a team lane (SPRINT2-STAFF-UI-PLAN.md §2);
 * shared chrome lives in screens/staff/shared/ + layout/StaffLayout.
 */
const staffScreens = {
  onboarding: { element: <OnboardingScreen />, roles: ["ADMIN"] },
  team: { element: <TeamScreen />, roles: ["ADMIN"] },
  catalog: { element: null, roles: ["ADMIN"] }, // Matthew's lane (S2-D4)
  alerts: { element: <AlertsScreen />, roles: ["ADMIN"] }, // view + withdraw driver-triggered alerts; full "publish new alert" form still Matthew's lane
  verify: { element: <VerifyScreen />, roles: ["INSPECTOR", "ADMIN"] },
  inspections: { element: <InspectionHistoryScreen />, roles: ["INSPECTOR", "ADMIN"] },
  runs: { element: <RunsScreen />, roles: ["DRIVER", "ADMIN"] },
  timetable: {
    element: <TimetableScreen hideCta />,
    roles: ["DRIVER", "ADMIN"],
  },
  inbox: { element: <InboxScreen />, roles: ["AGENT", "ADMIN"] },
  chats: { element: <ChatScreen />, roles: ["AGENT", "ADMIN"] },
  kiosk: { element: <KioskScreen />, roles: ["CLERK", "ADMIN"] },
  concessions: { element: <ConcessionsScreen />, roles: ["CLERK", "ADMIN"] },
  profile: { element: <StaffProfileScreen />, roles: "ANY_STAFF" },
};

const PROFILE_ROUTE_KEY = "profile"; // route key reserved for every staff member

export default function App() {
  return (
    <AuthProvider>
      <NotificationProvider>
        <Routes>
          <Route path="/" element={<SplashScreen />} />
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/register" element={<RegisterScreen />} />
          <Route path="/forgot-password" element={<ForgotPasswordScreen />} />
          <Route path="/reset-password" element={<ResetPasswordScreen />} />
          <Route path="/staff-signup" element={<StaffSignupScreen />} />
          <Route
            path="/staff/complete-signup"
            element={<StaffCompleteSignupScreen />}
          />
          <Route path="/account-created" element={<AccountCreatedScreen />} />
          <Route path="/check-email" element={<CheckEmailScreen />} />

          {/* Staff console: /staff + role tools nested under StaffLayout */}
          <Route
            path="/staff"
            element={
              <ProtectedRoute staff>
                <StaffLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<StaffHomeScreen />} />
            {Object.entries(staffScreens).map(([slug, cfg]) =>
              slug === PROFILE_ROUTE_KEY ? null : (
                <Route
                  key={slug}
                  path={slug}
                  element={
                    cfg.element ? (
                      <ProtectedRoute staff roles={cfg.roles}>
                        {cfg.element}
                      </ProtectedRoute>
                    ) : (
                      <ComingSoon slug={slug} />
                    )
                  }
                />
              ),
            )}
            {/* Every staff member gets a profile page (Home-first nav skeleton) */}
            <Route
              path="profile"
              element={
                <ProtectedRoute staff>
                  <StaffProfileScreen />
                </ProtectedRoute>
              }
            />
          </Route>

          {commuterTree}

          <Route path="*" element={<NotFoundScreen />} />
        </Routes>
      </NotificationProvider>
    </AuthProvider>
  );
}

function ComingSoon({ slug }) {
  return (
    <div
      className="min-h-dvh text-white flex items-center justify-center"
      style={{ background: "linear-gradient(180deg, #0b1526, #12203d)" }}
    >
      <div className="text-center">
        <p className="text-3xl mb-2">🚧</p>
        <h2 className="font-display text-lg font-bold">/staff/{slug}</h2>
        <p className="text-[13px] text-white/50 mt-1">
          Reserved lane — this module is on the Sprint 2 board.
        </p>
        <a
          href="/staff"
          className="inline-block mt-4 text-[12px] font-semibold text-gold-300 underline underline-offset-2"
        >
          Back to console
        </a>
      </div>
    </div>
  );
}
