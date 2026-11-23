import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CursorQuery } from '../common/pagination';

export class DeliveryLocationDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  @IsString()
  @Length(1, 300)
  address: string;

  /** Landmark directions — most PNG addresses are landmark-based. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class QuoteDto {
  @IsUUID()
  packageId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  quantity: number;

  /** Offers: promo code to apply (validated for this customer). */
  @IsOptional()
  @IsString()
  @Length(3, 30)
  promoCode?: string;
}

/** The customer's own position when placing the order (phone GPS), for monitoring. */
export class RequestPositionDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  /** GPS accuracy in metres. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  accuracyM?: number;
}

export class CreateOrderDto extends QuoteDto {
  /** A saved location; or send `location` instead. */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryLocationDto)
  location?: DeliveryLocationDto;

  /** Where the customer is right now (phone GPS), if they allow location. Shown to admins. */
  @IsOptional()
  @ValidateNested()
  @Type(() => RequestPositionDto)
  requestedFrom?: RequestPositionDto;

  /** account = charge the employee's company (corporate account). */
  @IsIn(['cod', 'cellmoney', 'wallet', 'account'])
  paymentMethod: 'cod' | 'cellmoney' | 'wallet' | 'account';

  /** Cell money number to charge (defaults to the account phone). */
  @IsOptional()
  @IsString()
  @Length(7, 20)
  msisdn?: string;
}

export class CancelDto {
  @IsString()
  @Length(1, 300)
  reason: string;
}

export class StartPaymentDto {
  @IsString()
  @Length(7, 20)
  msisdn: string;
}

export class PositionDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;
}

export class DeliveredDto {
  /** Optional proof-of-delivery photo key from POST /driver/uploads. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  proofPhotoKey?: string;
}

export class RateDto {
  @IsInt()
  @Min(1)
  @Max(5)
  stars: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class DisputeDto {
  @IsString()
  @Length(1, 50)
  category: string;

  @IsString()
  @Length(1, 2000)
  description: string;
}

export class ReassignDto {
  /** Assign directly to this driver; omit to release the order back to dispatch. */
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @IsString()
  @Length(1, 300)
  reason: string;
}

export class AdminOrdersQuery extends CursorQuery {
  @IsOptional()
  @IsString()
  status?: string;

  /** Short code, phone, or customer/driver name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsUUID()
  driverId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(['cod', 'cellmoney', 'wallet', 'account', 'bank_transfer'])
  paymentMethod?: 'cod' | 'cellmoney' | 'wallet' | 'account' | 'bank_transfer';

  /** ISO date-time, inclusive. */
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

/** Customer's signature drawn on the driver's phone at delivery (PNG, base64, ≤ 300 KB). */
export class SignatureDto {
  @IsString()
  @MaxLength(420_000)
  imagePng: string;

  /** Name of the person who received the water and signed. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  signedByName?: string;
}

export class SendReceiptDto {
  @IsString()
  @MaxLength(200)
  email: string;

  /** Customer app: also save this address on the customer's profile for next time. */
  @IsOptional()
  @IsBoolean()
  saveEmail?: boolean;
}

/** Manual booking: the driver books water for a customer (e.g. who phoned or waved them down). */
export class DriverBookingDto {
  /** The customer's phone. A new customer account is created if the number isn't registered yet. */
  @IsString()
  @Length(6, 20)
  phone: string;

  /** Customer's name (used for a new customer, or to fill in a missing name). */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  customerName?: string;

  @IsUUID()
  packageId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @ValidateNested()
  @Type(() => DeliveryLocationDto)
  location: DeliveryLocationDto;

  /**
   * cod = customer pays the driver cash; cellmoney = a payment request goes to [msisdn] (default: the customer's
   * phone); bank_transfer = the customer transfers to Cooper Waters with the order code as reference (the office
   * confirms it); account = charged to the customer's company account.
   */
  @IsIn(['cod', 'cellmoney', 'bank_transfer', 'account'])
  paymentMethod: 'cod' | 'cellmoney' | 'bank_transfer' | 'account';

  /** Cell money number to charge (defaults to the customer's phone). */
  @IsOptional()
  @IsString()
  @Length(6, 20)
  msisdn?: string;

  /** Bank transfer: the customer's transfer reference / receipt number, if they already paid. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  transferReference?: string;
}

/** Driver: retry the cell money request for a booked order, or take cash instead. */
export class DriverOrderPaymentDto {
  @IsIn(['cellmoney', 'cod'])
  method: 'cellmoney' | 'cod';

  @IsOptional()
  @IsString()
  @Length(6, 20)
  msisdn?: string;
}
