/**
 * Default notification templates, seeded into the DB and editable by admins (§9).
 * `{{var}}` placeholders. SMS bodies must be GSM-7 and ≤160 characters after substitution where possible.
 * All user-facing strings live here (or in the DB), never inline in business code, so Tok Pisin can be added later.
 */
export interface TemplateDef {
  key: string;
  pushTitle?: string;
  pushBody?: string;
  smsBody?: string;
  /** Critical events always also go by SMS. */
  critical: boolean;
}

export const DEFAULT_TEMPLATES: TemplateDef[] = [
  { key: 'auth.otp', smsBody: 'Cooper Waters code: {{code}}. Valid {{minutes}} min. Do not share it.', critical: true },
  {
    key: 'order.payment_pending',
    pushTitle: 'Complete your payment',
    pushBody: 'Pay {{amount}} by cell money for order {{shortCode}}.',
    smsBody: 'Cooper Waters: pay {{amount}} for order {{shortCode}}. {{instructions}}',
    critical: false,
  },
  {
    key: 'order.searching',
    pushTitle: 'Finding a driver',
    pushBody: 'We are finding a water cart for order {{shortCode}}.',
    critical: false,
  },
  {
    key: 'order.accepted',
    pushTitle: 'Driver on the way',
    pushBody: '{{driverName}} ({{plate}}) accepted order {{shortCode}}.',
    smsBody: 'Cooper Waters: {{driverName}} ({{plate}}) accepted order {{shortCode}}. Track it in the app.',
    critical: true,
  },
  { key: 'order.loading', pushTitle: 'Loading water', pushBody: 'Your driver is loading water for {{shortCode}}.', critical: false },
  { key: 'order.en_route', pushTitle: 'On the way', pushBody: 'Your water for {{shortCode}} is on the way.', critical: false },
  {
    key: 'order.arrived',
    pushTitle: 'Driver has arrived',
    pushBody: 'Your driver has arrived with order {{shortCode}}.',
    smsBody: 'Cooper Waters: your driver has arrived with order {{shortCode}}.',
    critical: true,
  },
  {
    key: 'order.delivered',
    pushTitle: 'Water delivered',
    pushBody: 'Order {{shortCode}} is delivered. Please confirm receipt and rate your driver.',
    critical: false,
  },
  { key: 'order.completed', pushTitle: 'Order complete', pushBody: 'Thank you! Order {{shortCode}} is complete.', critical: false },
  {
    key: 'order.cancelled',
    pushTitle: 'Order cancelled',
    pushBody: 'Order {{shortCode}} was cancelled. {{reason}}',
    critical: false,
  },
  {
    key: 'order.expired',
    pushTitle: 'No driver available',
    pushBody: 'Sorry, no driver accepted order {{shortCode}}. Please try again.',
    smsBody: 'Cooper Waters: no driver was available for order {{shortCode}}. Please try again later.',
    critical: true,
  },
  {
    key: 'order.disputed',
    pushTitle: 'Issue reported',
    pushBody: 'An issue was reported on order {{shortCode}}. Our team will contact you.',
    critical: false,
  },
  {
    key: 'payment.failed',
    pushTitle: 'Payment failed',
    pushBody: 'Payment for {{shortCode}} did not go through.',
    smsBody: 'Cooper Waters: payment for {{shortCode}} failed or timed out. The order was not placed.',
    critical: true,
  },
  {
    key: 'refund.issued',
    pushTitle: 'Refund issued',
    pushBody: '{{amount}} has been refunded for order {{shortCode}}.',
    smsBody: 'Cooper Waters: {{amount}} refunded for order {{shortCode}}.',
    critical: true,
  },
  {
    key: 'driver.offer',
    pushTitle: 'New job',
    pushBody: '{{volume}}L, {{distanceKm}} km away. Earn {{earnings}}.',
    critical: false,
  },
  { key: 'driver.offer_taken', pushTitle: 'Job taken', pushBody: 'Order {{shortCode}} was taken by another driver.', critical: false },
  {
    key: 'driver.approved',
    pushTitle: 'You are approved',
    pushBody: 'Your Cooper Waters driver account is approved. Top up your wallet and go online.',
    smsBody: 'Cooper Waters: your driver account is approved. Top up your wallet and go online.',
    critical: true,
  },
  {
    key: 'driver.rejected',
    pushTitle: 'Application update',
    pushBody: 'Your application needs attention: {{reason}}',
    critical: false,
  },
  {
    key: 'driver.document_rejected',
    pushTitle: 'Document rejected',
    pushBody: 'Please re-upload your {{type}}: {{reason}}',
    critical: false,
  },
  {
    key: 'driver.order_cancelled',
    pushTitle: 'Job cancelled',
    pushBody: 'Order {{shortCode}} was cancelled. {{reason}}',
    critical: false,
  },
  {
    key: 'driver.low_balance',
    pushTitle: 'Top up needed',
    pushBody: 'Your wallet is {{balance}}. Top up to at least {{minimum}} to take jobs.',
    critical: false,
  },
  {
    key: 'driver.earning',
    pushTitle: 'Earnings credited',
    pushBody: '{{amount}} credited for order {{shortCode}}.',
    critical: false,
  },
  {
    key: 'referral.rewarded',
    pushTitle: 'Referral reward',
    pushBody: '{{amount}} was added to your wallet. Thanks for spreading the word!',
    smsBody: 'Cooper Waters: referral reward {{amount}} added. Wallet balance {{balance}}.',
    critical: false,
  },
  {
    key: 'chat.message',
    pushTitle: '{{sender}} ({{shortCode}})',
    pushBody: '{{preview}}',
    critical: false,
  },
  {
    key: 'topup.approved',
    pushTitle: 'Top-up approved',
    pushBody: '{{amount}} was added to your wallet.',
    smsBody: 'Cooper Waters: top-up of {{amount}} approved. New balance {{balance}}.',
    critical: true,
  },
  {
    key: 'topup.rejected',
    pushTitle: 'Top-up rejected',
    pushBody: 'Your top-up of {{amount}} was rejected: {{reason}}',
    smsBody: 'Cooper Waters: top-up of {{amount}} rejected. {{reason}}',
    critical: true,
  },
  {
    key: 'wallet.adjusted',
    pushTitle: 'Wallet updated',
    pushBody: '{{amount}} {{direction}} your wallet by Cooper Waters: {{reason}}. New balance {{balance}}.',
    critical: false,
  },
  {
    key: 'payout.paid',
    pushTitle: 'Withdrawal paid',
    pushBody: '{{amount}} has been paid out to you.',
    critical: false,
  },
  {
    key: 'payout.rejected',
    pushTitle: 'Withdrawal rejected',
    pushBody: 'Your withdrawal of {{amount}} was rejected: {{reason}}',
    critical: false,
  },
];

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k]))).replace(/\s+$/g, '');
}
