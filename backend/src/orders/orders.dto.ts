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

export class CreateOrderDto extends QuoteDto {
  /** A saved location; or send `location` instead. */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryLocationDto)
  location?: DeliveryLocationDto;

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
  @IsIn(['cod', 'cellmoney'])
  paymentMethod?: 'cod' | 'cellmoney';

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
