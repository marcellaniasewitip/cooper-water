# Dispatch rules, zones, auto-assign, corporate accounts, daily report

## Truck size must match the order exactly
A 10,000 L order goes only to drivers whose registered truck holds exactly 10,000 L (not smaller, not
bigger). Drivers pick their truck size when they sign up, and can only pick a size that customers can
order, so **add a package for every truck size you run** (Admin → Packages), e.g. "10,000 L".
Setting: `dispatch.match_vehicle_size` (on).

## Zones
Admin → **Zones** → *New zone* → *Draw on map* (click the corners) → *Save*.
An order placed inside a zone is offered only to drivers whose live GPS is inside the same zone.
Orders outside every zone go to any nearby driver. Turn a zone off to suspend it.
Setting: `dispatch.zone_restricted` (on).

## Auto-assign
Admin → **Live fleet map** → **Auto-assign** switch.
- **On:** each order is placed with the nearest matching driver only. The customer and admins see
  "Order CW-1234 is placed to <driver>". If the driver declines, or doesn't accept within
  `dispatch.auto_assign_timeout_sec` (60 s), it moves to the next nearest driver.
- **Off:** every nearby matching driver gets the offer and the first to accept wins.

## Corporate accounts
Admin → **Companies** → *New company*: name, accounts email, **credit limit** (how much they may owe).
Add employees by the phone number they signed up with. In the customer app they then see
**Company account** at checkout:
- each order is debited to the company straight away (refunded if it's cancelled or expires);
- orders are refused once the company would owe more than its credit limit;
- *Record payment* when the company pays its bill;
- the month's total (orders, litres, charged, paid, balance) is worked out automatically. On the 1st of
  each month last month's statement is closed and emailed to the accounts email. Each month has a CSV
  of every order.

## Daily report
Admin → **Daily report**: pick one day (◀ ▶ to step). Shows every order placed (or delivered) that day:
order time, delivery time and minutes taken, customer, company, driver and truck, water, address,
amount and payment, the customer's star rating and comment, disputes, signature and receipt.
*Download this day (CSV)* exports the same.

## Automatic receipts
After delivery the receipt is emailed automatically (after up to 5 minutes, or as soon as the customer
signs) to the customer's email on file and, for company orders, the company's accounts email. It's
skipped if a receipt was already sent by hand. Settings: `receipt.auto_send` (on),
`receipt.auto_send_delay_sec` (300). Email needs `SMTP_URL` / `EMAIL_FROM` (see email-receipts.md).
