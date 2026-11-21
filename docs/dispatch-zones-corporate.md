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

## Manual booking (driver books for a customer)
Driver app → menu → **Book for a customer**. For a customer who phoned the driver or stopped the truck:
enter the customer's phone number (the app shows whether it's a registered customer; a new number gets a
customer account automatically), their name, the water (only packages matching the driver's truck size),
the delivery address (type to search, or **Use my location**) and payment (cash, or company account when
the customer belongs to a company). **Book and start the job** creates the order already assigned to that
driver — it is not offered to other drivers — and the customer gets the usual "driver accepted" SMS/push.
The customer can later sign in with that phone number and see the order. The same rules apply as for
accepting jobs: one job at a time and the wallet above the minimum. Admins see these orders like any other.
