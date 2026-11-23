import {
  IconAlertTriangle,
  IconBuilding,
  IconCalendarEvent,
  IconBuildingWarehouse,
  IconPolygon,
  IconCash,
  IconChartBar,
  IconCoins,
  IconDashboard,
  IconFileText,
  IconListDetails,
  IconMap2,
  IconMapPin,
  IconMessage,
  IconSpeakerphone,
  IconPackage,
  IconDiscount2,
  IconReceipt,
  IconSettings,
  IconShieldLock,
  IconSteeringWheel,
  IconTruck,
  IconUsers,
  IconWallet,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import type { PermissionRequirement } from '@/auth/permissions';
import { m } from '@/i18n';

export interface NavItem {
  label: string;
  to?: string;
  icon?: Icon;
  permission?: PermissionRequirement;
  children?: NavItem[];
  /** Overview badge key for pending counts. */
  badge?: 'driverApprovals' | 'topups' | 'payouts' | 'disputes' | 'payments';
}

export const NAV: NavItem[] = [
  { label: m.nav.overview, to: '/', icon: IconDashboard, permission: 'dashboard.view' },
  { label: m.nav.fleet, to: '/fleet', icon: IconMap2, permission: 'dashboard.view' },
  { label: m.nav.liveRequests, to: '/requests', icon: IconMapPin, permission: 'orders.view' },
  {
    label: m.nav.operations,
    children: [
      { label: m.nav.orders, to: '/orders', icon: IconListDetails, permission: 'orders.view' },
      { label: m.nav.customers, to: '/customers', icon: IconUsers, permission: 'customers.view' },
      { label: m.nav.companies, to: '/companies', icon: IconBuilding, permission: 'customers.view' },
      { label: m.nav.drivers, to: '/drivers', icon: IconSteeringWheel, permission: 'drivers.view', badge: 'driverApprovals' },
      { label: m.nav.trucks, to: '/trucks', icon: IconTruck, permission: 'trucks.manage' },
      { label: m.nav.disputes, to: '/disputes', icon: IconAlertTriangle, permission: 'disputes.resolve', badge: 'disputes' },
    ],
  },
  {
    label: m.nav.money,
    children: [
      { label: m.nav.topups, to: '/topups', icon: IconCoins, permission: 'wallet.view', badge: 'topups' },
      { label: m.nav.payments, to: '/payments', icon: IconReceipt, permission: 'payments.view', badge: 'payments' },
      { label: m.nav.payouts, to: '/payouts', icon: IconCash, permission: 'payouts.process', badge: 'payouts' },
      { label: m.nav.platformWallet, to: '/wallet', icon: IconWallet, permission: 'wallet.view' },
      { label: m.nav.dayReport, to: '/reports/day', icon: IconCalendarEvent, permission: 'reports.view' },
      { label: m.nav.reports, to: '/reports', icon: IconChartBar, permission: 'reports.view' },
    ],
  },
  {
    label: m.nav.catalogue,
    children: [
      { label: m.nav.depots, to: '/depots', icon: IconBuildingWarehouse, permission: 'dashboard.view' },
      { label: m.nav.zones, to: '/zones', icon: IconPolygon, permission: 'dashboard.view' },
      { label: m.nav.packages, to: '/packages', icon: IconPackage, permission: 'orders.view' },
      { label: m.nav.promos, to: '/promos', icon: IconDiscount2, permission: 'orders.view' },
      { label: m.nav.settings, to: '/settings', icon: IconSettings, permission: 'settings.edit' },
      { label: m.nav.templates, to: '/templates', icon: IconMessage, permission: 'notifications.edit' },
      { label: m.nav.broadcasts, to: '/broadcasts', icon: IconSpeakerphone, permission: 'notifications.edit' },
    ],
  },
  {
    label: m.nav.admin,
    children: [
      { label: m.nav.admins, to: '/admins', icon: IconShieldLock, permission: 'admins.manage' },
      { label: m.nav.audit, to: '/audit', icon: IconFileText, permission: 'audit.view' },
    ],
  },
];

/** First route the admin may open (used when they lack dashboard.view). */
export function firstAllowedPath(items: NavItem[]): string | null {
  for (const it of items) {
    if (it.to) return it.to;
    if (it.children) {
      const c = firstAllowedPath(it.children);
      if (c) return c;
    }
  }
  return null;
}
