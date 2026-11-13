import { Alert, Button, Code, Group, Stack, Text } from '@mantine/core';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Catches a crash in one page so the dashboard shows a message (with Retry) instead of going blank.
 * `resetKey` (e.g. the URL) clears the error when the admin navigates elsewhere.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page crashed', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Alert color="red" variant="light" title="Something went wrong on this page" data-testid="page-error">
        <Stack gap="sm">
          <Text size="sm">Your data is safe. Try again, or reload the page. If it keeps happening, send this message to support:</Text>
          <Code block>{this.state.error.message}</Code>
          <Group>
            <Button size="xs" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button size="xs" variant="default" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  }
}
