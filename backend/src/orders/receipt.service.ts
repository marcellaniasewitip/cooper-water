import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import { formatKina } from '../common/money';
import { EMAIL_PROVIDER, EmailProvider } from '../notifications/email.provider';
import { logger } from '../common/logger';

/** Receipts can be emailed once the water has been handed over. */
const RECEIPT_STATUSES = ['DELIVERED', 'COMPLETED', 'DISPUTED'];
const MAX_SENDS = 10;
const MAX_SIGNATURE_BYTES = 300 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pomTime = (d: Date | null | undefined) =>
  d ? d.toLocaleString('en-GB', { timeZone: 'Pacific/Port_Moresby', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const PAYMENT: Record<string, string> = { cod: 'Cash on delivery', cellmoney: 'Cell money', wallet: 'Cooper Waters wallet' };

/**
 * Proof of delivery: the customer signs on the driver's phone, and a receipt (with the signature) can be
 * emailed to the customer's address on file or to any address typed in at the door.
 */
@Injectable()
export class ReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Save the customer's signature (PNG, base64) for a delivered order. Signing again replaces it. */
  async saveSignature(driverId: string, orderId: string, pngBase64: string, signedByName?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.driverId !== driverId) throw Errors.notFound('Order');
    if (!['ARRIVED', ...RECEIPT_STATUSES].includes(order.status)) {
      throw Errors.conflict('signature_too_early', 'The customer can sign once you have arrived with the water');
    }
    const png = Buffer.from(pngBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (png.length < PNG_MAGIC.length || !png.subarray(0, 8).equals(PNG_MAGIC)) throw Errors.invalid('signature_invalid', 'The signature must be a PNG image');
    if (png.length > MAX_SIGNATURE_BYTES) throw Errors.invalid('signature_too_large', 'The signature image is too large');
    const name = (signedByName ?? '').trim().slice(0, 80);
    await this.prisma.orderSignature.upsert({
      where: { orderId },
      create: { orderId, png, signedByName: name, driverId },
      update: { png, signedByName: name, signedAt: new Date(), driverId },
    });
    return { signed: true, signedByName: name };
  }

  /** Email the receipt. `by` says who pressed Send (driver at the door, or the customer in their app). */
  async send(orderId: string, rawEmail: string, by: { driverId?: string; customerId?: string }) {
    const to = rawEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(to) || to.length > 200) throw Errors.invalid('email_invalid', 'Enter a valid email address');
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        package: true,
        customer: { select: { name: true, phone: true } },
        driver: { include: { user: { select: { name: true } }, trucks: { where: { active: true, deletedAt: null }, take: 1 } } },
        signature: true,
      },
    });
    const mine = o && ((by.driverId && o.driverId === by.driverId) || (by.customerId && o.customerId === by.customerId));
    if (!o || !mine) throw Errors.notFound('Order');
    if (!RECEIPT_STATUSES.includes(o.status)) throw Errors.conflict('receipt_too_early', 'The receipt can be sent once the water has been delivered');
    if (o.receiptSendCount >= MAX_SENDS) throw Errors.conflict('receipt_limit', 'This receipt has already been sent many times');

    const payable = o.priceToea - o.discountToea;
    const rows: [string, string][] = [
      ['Order', o.shortCode],
      ['Delivered', pomTime(o.deliveredAt)],
      ['Delivered to', o.deliveryAddress],
      ['Water', `${o.quantity} × ${o.package.name} (${(o.package.volumeLitres * o.quantity).toLocaleString('en-US')} L)`],
      ['Price', formatKina(o.priceToea)],
      ...(o.discountToea > 0 ? ([['Promo discount', `−${formatKina(o.discountToea)}`]] as [string, string][]) : []),
      ['Total paid', formatKina(payable)],
      ['Payment', PAYMENT[o.paymentMethod] ?? o.paymentMethod],
      ['Driver', `${o.driver?.user?.name ?? '—'}${o.driver?.trucks?.[0] ? ` · Truck ${o.driver.trucks[0].plate}` : ''}`],
      ['Customer', o.customer?.name ?? o.customer?.phone ?? '—'],
    ];
    const sig = o.signature;
    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1b2b3a;background:#f4f7fb;padding:24px">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<tr><td><h2 style="margin:0 0 4px;color:#0b5394">Cooper Waters</h2><p style="margin:0 0 16px;color:#5c6b7a">Delivery receipt</p>
<table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">
${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#5c6b7a;width:40%">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join('\n')}
</table>
${sig ? `<p style="margin:20px 0 4px;color:#5c6b7a;font-size:13px">Received and signed by ${esc(sig.signedByName || 'the customer')} · ${esc(pomTime(sig.signedAt))}</p><img src="cid:signature" alt="Customer signature" style="max-width:100%;height:auto;border:1px solid #d0d7de;border-radius:8px;background:#fff">` : ''}
<p style="margin:24px 0 0;color:#8a96a3;font-size:12px">Thank you for choosing Cooper Waters. Questions? Reply to this email or contact us in the app.</p>
</td></tr></table></body></html>`;
    const text = [
      'Cooper Waters — delivery receipt',
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      ...(sig ? ['', `Received and signed by ${sig.signedByName || 'the customer'} · ${pomTime(sig.signedAt)}`] : []),
    ].join('\n');

    try {
      await this.email.send({
        to,
        subject: `Cooper Waters receipt · ${o.shortCode}`,
        html,
        text,
        inline: sig ? [{ cid: 'signature', filename: 'signature.png', contentType: 'image/png', content: Buffer.from(sig.png) }] : [],
      });
    } catch (err) {
      logger.warn({ err: String((err as Error)?.message ?? err), orderId }, 'Receipt email failed');
      throw Errors.unavailable('email_unavailable', 'The receipt could not be sent right now. Try again in a moment.');
    }
    await this.prisma.order.update({ where: { id: o.id }, data: { receiptEmail: to, receiptSentAt: new Date(), receiptSendCount: { increment: 1 } } });
    return { sent: true, email: to, configured: this.email.configured };
  }
}
