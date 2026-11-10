import { MantineProvider, createTheme, Center, Loader } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError } from '@/api';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { filterByPermission, type PermissionRequirement } from '@/auth/permissions';
import { AppLayout } from '@/components/AppLayout';
import { NotFound, RequireAuth, RequirePerm } from '@/components/Guards';
import { firstAllowedPath, NAV } from '@/nav';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import { LoginPage } from '@/pages/LoginPage';

const OverviewPage = lazy(() => import('@/pages/OverviewPage'));
const FleetPage = lazy(() => import('@/pages/FleetPage'));
const OrdersPage = lazy(() => import('@/pages/OrdersPage'));
const OrderDetailPage = lazy(() => import('@/pages/OrderDetailPage'));
const CustomersPage = lazy(() => import('@/pages/CustomersPage'));
const CustomerDetailPage = lazy(() => import('@/pages/CustomerDetailPage'));
const DriversPage = lazy(() => import('@/pages/DriversPage'));
const DriverDetailPage = lazy(() => import('@/pages/DriverDetailPage'));
const TrucksPage = lazy(() => import('@/pages/TrucksPage'));
const DepotsPage = lazy(() => import('@/pages/DepotsPage'));
const PackagesPage = lazy(() => import('@/pages/PackagesPage'));
const PromosPage = lazy(() => import('@/pages/PromosPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const TopupsPage = lazy(() => import('@/pages/TopupsPage'));
const PaymentsPage = lazy(() => import('@/pages/PaymentsPage'));
const PayoutsPage = lazy(() => import('@/pages/PayoutsPage'));
const DisputesPage = lazy(() => import('@/pages/DisputesPage'));
const DisputeDetailPage = lazy(() => import('@/pages/DisputeDetailPage'));
const TemplatesPage = lazy(() => import('@/pages/TemplatesPage'));
const AdminsPage = lazy(() => import('@/pages/AdminsPage'));
const AuditPage = lazy(() => import('@/pages/AuditPage'));
const ReportsPage = lazy(() => import('@/pages/ReportsPage'));
const PlatformWalletPage = lazy(() => import('@/pages/PlatformWalletPage'));
const ProfilePage = lazy(() => import('@/pages/ProfilePage'));

const theme = createTheme({
  // Brand "ocean" blue (shade 6 is the main brand colour).
  colors: {
    ocean: ['#e7f4fc', '#cfe7f7', '#a0ceee', '#6db3e4', '#439cdb', '#2a8ed6', '#1683cf', '#0570b7', '#0063a4', '#005591'],
  },
  primaryColor: 'ocean',
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  headings: { fontWeight: '700' },
  components: {
    Card: { defaultProps: { radius: 'lg', shadow: 'xs' } },
    Paper: { defaultProps: { radius: 'lg' } },
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Don't retry client errors (403/404/422…); do retry flaky networks and rate limits (429).
      retry: (count, err) => {
        if (err instanceof ApiError && err.status === 429) return count < 4;
        return !(err instanceof ApiError && err.status < 500) && count < 2;
      },
      retryDelay: (count, err) => {
        const after = err instanceof ApiError ? Number((err.details as { retryAfterSec?: number } | undefined)?.retryAfterSec) : NaN;
        return Number.isFinite(after) && after > 0 ? after * 1000 : Math.min(1000 * 2 ** count, 15_000);
      },
    },
  },
});

const fallback = (
  <Center p="xl">
    <Loader />
  </Center>
);

function P({ perm, children }: { perm?: PermissionRequirement; children: ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      <RequirePerm perm={perm}>{children}</RequirePerm>
    </Suspense>
  );
}

function Home() {
  const { can, me } = useAuth();
  if (can('dashboard.view'))
    return (
      <Suspense fallback={fallback}>
        <OverviewPage />
      </Suspense>
    );
  const first = firstAllowedPath(filterByPermission(NAV, me?.permissions));
  return <Navigate to={first ?? '/profile'} replace />;
}

export function App() {
  return (
    <MantineProvider theme={theme}>
      <ModalsProvider>
        <Notifications position="top-right" limit={5} />
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RealtimeProvider>
              <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route
                    element={
                      <RequireAuth>
                        <AppLayout />
                      </RequireAuth>
                    }
                  >
                    <Route index element={<Home />} />
                    <Route path="fleet" element={<P perm="dashboard.view"><FleetPage /></P>} />
                    <Route path="orders" element={<P perm="orders.view"><OrdersPage /></P>} />
                    <Route path="orders/:id" element={<P perm="orders.view"><OrderDetailPage /></P>} />
                    <Route path="customers" element={<P perm="customers.view"><CustomersPage /></P>} />
                    <Route path="customers/:id" element={<P perm="customers.view"><CustomerDetailPage /></P>} />
                    <Route path="drivers" element={<P perm="drivers.view"><DriversPage /></P>} />
                    <Route path="drivers/:id" element={<P perm="drivers.view"><DriverDetailPage /></P>} />
                    <Route path="trucks" element={<P perm="trucks.manage"><TrucksPage /></P>} />
                    <Route path="depots" element={<P perm="dashboard.view"><DepotsPage /></P>} />
                    <Route path="packages" element={<P perm="orders.view"><PackagesPage /></P>} />
                    <Route path="promos" element={<P perm="orders.view"><PromosPage /></P>} />
                    <Route path="settings" element={<P perm="settings.edit"><SettingsPage /></P>} />
                    <Route path="templates" element={<P perm="notifications.edit"><TemplatesPage /></P>} />
                    <Route path="topups" element={<P perm="wallet.view"><TopupsPage /></P>} />
                    <Route path="payments" element={<P perm="payments.view"><PaymentsPage /></P>} />
                    <Route path="payouts" element={<P perm="payouts.process"><PayoutsPage /></P>} />
                    <Route path="wallet" element={<P perm="wallet.view"><PlatformWalletPage /></P>} />
                    <Route path="disputes" element={<P perm="disputes.resolve"><DisputesPage /></P>} />
                    <Route path="disputes/:id" element={<P perm="disputes.resolve"><DisputeDetailPage /></P>} />
                    <Route path="reports" element={<P perm="reports.view"><ReportsPage /></P>} />
                    <Route path="admins" element={<P perm="admins.manage"><AdminsPage /></P>} />
                    <Route path="audit" element={<P perm="audit.view"><AuditPage /></P>} />
                    <Route path="profile" element={<P><ProfilePage /></P>} />
                    <Route path="*" element={<NotFound />} />
                  </Route>
                </Routes>
              </BrowserRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>
  );
}
