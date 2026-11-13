import { Alert, Button, Group, Modal, Stack, Text, TextInput, Textarea, type MantineColor } from '@mantine/core';
import { useEffect, useState, type ReactNode } from 'react';
import { errorMessage } from '@/api/client';
import { m } from '@/i18n';
import { parseKinaToToea } from '@/lib/money';
import { notifyError, notifySuccess } from '@/lib/notify';

export interface ActionField {
  name: string;
  label: string;
  /** kina / kinaSigned fields are validated as Kina amounts (≤ 2 decimals). */
  type?: 'text' | 'textarea' | 'kina' | 'kinaSigned' | 'password';
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  description?: ReactNode;
  initial?: string;
}

export interface ActionModalProps {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  body?: ReactNode;
  fields?: ActionField[];
  confirmLabel?: string;
  color?: MantineColor;
  /** Values are raw strings; Kina fields are guaranteed parseable. Throw to keep the modal open. */
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  successMessage?: string;
  children?: ReactNode;
  /** Extra client-side validation; return an error message to block submit. */
  validate?: (values: Record<string, string>) => string | null;
}

function fieldError(f: ActionField, raw: string): string | null {
  const v = raw.trim();
  if (f.required && !v) return m.common.required;
  if (!v) return null;
  if (f.minLength && v.length < f.minLength) return `${m.common.required}: ≥ ${f.minLength}`;
  if (f.maxLength && v.length > f.maxLength) return `≤ ${f.maxLength}`;
  if (f.type === 'kina' && parseKinaToToea(v) === null) return m.common.invalidAmount;
  if (f.type === 'kinaSigned' && parseKinaToToea(v, { allowNegative: true }) === null) return m.common.invalidAmount;
  return null;
}

/**
 * Confirmation modal for destructive / money actions, optionally collecting a reason or reference.
 * Errors from the backend are shown inline and as a toast; the modal stays open so the same action can be retried.
 */
export function ActionModal({ opened, onClose, title, body, fields = [], confirmLabel, color = 'blue', onSubmit, successMessage, children, validate }: ActionModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (opened) {
      setValues(Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ''])));
      setTouched(false);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const errors = Object.fromEntries(fields.map((f) => [f.name, fieldError(f, values[f.name] ?? '')]));
  const hasErrors = Object.values(errors).some(Boolean);
  const customError = !hasErrors && validate ? validate(values) : null;

  const submit = async () => {
    setTouched(true);
    if (hasErrors || customError) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
      if (successMessage) notifySuccess(successMessage);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={busy ? () => undefined : onClose} title={<Text fw={600}>{title}</Text>} centered size="lg">
      <Stack>
        {body && (typeof body === 'string' ? <Text size="sm">{body}</Text> : body)}
        {children}
        {fields.map((f) => {
          const common = {
            label: f.label,
            description: f.description,
            placeholder: f.placeholder ?? (f.type === 'kina' || f.type === 'kinaSigned' ? m.common.kinaHint : undefined),
            withAsterisk: f.required,
            value: values[f.name] ?? '',
            error: touched ? errors[f.name] : undefined,
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
              // Read the value now: React clears currentTarget after the event, before the state updater runs.
              const value = e.currentTarget.value;
              setValues((s) => ({ ...s, [f.name]: value }));
            },
            'data-autofocus': f === fields[0] ? true : undefined,
          };
          return f.type === 'textarea' ? (
            <Textarea key={f.name} {...common} autosize minRows={3} maxLength={f.maxLength} />
          ) : (
            <TextInput
              key={f.name}
              {...common}
              type={f.type === 'password' ? 'password' : 'text'}
              inputMode={f.type === 'kina' || f.type === 'kinaSigned' ? 'decimal' : undefined}
              leftSection={f.type === 'kina' || f.type === 'kinaSigned' ? 'K' : undefined}
              maxLength={f.maxLength}
            />
          );
        })}
        {touched && customError && (
          <Text c="red" size="sm">
            {customError}
          </Text>
        )}
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            {m.common.cancel}
          </Button>
          <Button color={color} onClick={submit} loading={busy}>
            {confirmLabel ?? m.common.confirm}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
