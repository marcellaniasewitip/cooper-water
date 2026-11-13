import { Avatar, AppShell, Badge, Box, Burger, Group, Menu, NavLink, ScrollArea, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconDroplet, IconLogout, IconUserShield } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink as RouterNavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { filterByPermission } from '@/auth/permissions';
import { config } from '@/config';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { m } from '@/i18n';
import { NAV, type NavItem } from '@/nav';
import { useRealtime } from '@/realtime/RealtimeProvider';

function NavEntry({ item, counts, onNavigate }: { item: NavItem; counts?: Record<string, number>; onNavigate: () => void }) {
  const { pathname } = useLocation();
  const Icon = item.icon;
  const n = item.badge && counts ? counts[item.badge] : 0;
  const active = item.to === '/' ? pathname === '/' : !!item.to && pathname.startsWith(item.to);
  return (
    <NavLink
      component={RouterNavLink}
      to={item.to!}
      label={item.label}
      active={active}
      onClick={onNavigate}
      leftSection={Icon ? <Icon size={18} stroke={1.6} /> : undefined}
      rightSection={
        n ? (
          <Badge size="sm" color="red" circle={n < 10}>
            {n}
          </Badge>
        ) : undefined
      }
    />
  );
}

export function AppLayout() {
  const { pathname } = useLocation();
  const [opened, { toggle, close }] = useDisclosure();
  const { me, signOut, can } = useAuth();
  const { connected } = useRealtime();
  const nav = filterByPermission(NAV, me?.permissions);

  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    enabled: can('dashboard.view'),
    refetchInterval: connected ? 120_000 : config.pollMs.overview,
  });
  const p = overview.data?.pending;
  const counts = p ? { driverApprovals: p.driverApprovals, topups: p.topups, payouts: p.payouts, disputes: p.disputes, payments: p.manualPayments + p.refunds } : undefined;

  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 260, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding={{ base: 'sm', sm: 'md', lg: 'lg' }}>
      <AppShell.Header className="cw-header">
        <Group h="100%" px={{ base: 'sm', sm: 'md' }} justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" miw={0}>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <ThemeIcon variant="white" radius="xl" size="lg">
              <IconDroplet size={20} />
            </ThemeIcon>
            <Text fw={700} c="white" truncate>
              {m.app.name}
            </Text>
            <Text c="rgba(255,255,255,0.65)" size="sm" visibleFrom="xs">
              {m.app.subtitle}
            </Text>
          </Group>
          <Group gap="sm" wrap="nowrap">
            {can('dashboard.view') && (
              <Tooltip label={connected ? 'Socket.IO /realtime' : `${config.pollMs.fleet / 1000}s`}>
                <div>
                  <Badge variant="dot" color={connected ? 'teal' : 'gray'} data-testid="realtime-status" visibleFrom="xs">
                    {connected ? m.app.realtimeOn : m.app.realtimeOff}
                  </Badge>
                  <Box hiddenFrom="xs" w={10} h={10} bg={connected ? 'teal.4' : 'gray.5'} style={{ borderRadius: '50%', boxShadow: '0 0 0 3px rgba(255,255,255,0.18)' }} aria-label={connected ? m.app.realtimeOn : m.app.realtimeOff} />
                </div>
              </Tooltip>
            )}
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <UnstyledButton c="white">
                  <Group gap={8} wrap="nowrap">
                    <Avatar size={32} radius="xl" color="ocean" variant="white">
                      {me?.name?.trim().charAt(0).toUpperCase()}
                    </Avatar>
                    <Box visibleFrom="sm">
                      <Text size="sm" fw={600} lh={1.15}>
                        {me?.name}
                      </Text>
                      <Text size="xs" c="rgba(255,255,255,0.7)" lh={1.15}>
                        {me?.role.name}
                      </Text>
                    </Box>
                    <IconChevronDown size={14} />
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{me?.email}</Menu.Label>
                <Menu.Item component={Link} to="/profile" leftSection={<IconUserShield size={16} />}>
                  {m.app.profile}
                </Menu.Item>
                <Menu.Item color="red" leftSection={<IconLogout size={16} />} onClick={() => void signOut()}>
                  {m.app.signOut}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs" className="cw-navbar">
        <ScrollArea>
          {nav.map((item) =>
            item.children ? (
              <div key={item.label}>
                <Text size="xs" fw={700} tt="uppercase" px="sm" pt="md" pb={4} className="cw-nav-section">
                  {item.label}
                </Text>
                {item.children.map((c) => (
                  <NavEntry key={c.to} item={c} counts={counts} onNavigate={close} />
                ))}
              </div>
            ) : (
              <NavEntry key={item.to} item={item} counts={counts} onNavigate={close} />
            ),
          )}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </AppShell.Main>
    </AppShell>
  );
}
