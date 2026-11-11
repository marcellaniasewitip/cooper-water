import {
  Allow,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { CursorQuery } from '../common/pagination';

export class ReasonDto {
  @IsString()
  @Length(1, 500)
  reason: string;
}

export class OptionalReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReviewDocumentDto {
  @IsIn(['approved', 'rejected'])
  status: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ListQuery extends CursorQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  online?: string;
}

export class PaymentsQuery extends CursorQuery {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsIn(['order', 'topup', 'refund', 'payout'])
  purpose?: 'order' | 'topup' | 'refund' | 'payout';

  @IsOptional()
  @IsString()
  adapter?: string;

  /** Search by reference (order short code / top-up ref), MSISDN or provider ref. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class DepotDto {
  @IsString()
  @Length(1, 100)
  name: string;

  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(5000)
  geofenceRadiusM?: number | null;

  /** GeoJSON Polygon `{ type: 'Polygon', coordinates: [[[lng, lat], ...]] }`. */
  @ApiPropertyOptional({ type: 'object', nullable: true, description: 'GeoJSON Polygon; null clears it', additionalProperties: true })
  @IsOptional()
  @IsObject()
  geofencePolygon?: { type: 'Polygon'; coordinates: number[][][] } | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateDepotDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @IsInt() @Min(10) @Max(5000) geofenceRadiusM?: number | null;
  @ApiPropertyOptional({ type: 'object', nullable: true, description: 'GeoJSON Polygon; null clears it', additionalProperties: true })
  @IsOptional() @IsObject() geofencePolygon?: { type: 'Polygon'; coordinates: number[][][] } | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class PackageDto {
  @IsString()
  @Length(1, 100)
  name: string;

  @IsInt()
  @Min(1)
  volumeLitres: number;

  @IsInt()
  @Min(0)
  priceToea: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdatePackageDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsInt() @Min(1) volumeLitres?: number;
  @IsOptional() @IsInt() @Min(0) priceToea?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class TruckUpdateDto {
  @IsOptional() @IsString() @Length(2, 20) plate?: string;
  @IsOptional() @IsInt() @Min(100) capacityLitres?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class SettingValueDto {
  /** JSON value; type must match the setting. */
  @ApiProperty({ description: 'Any JSON value (number, string, boolean or list)', oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }, { type: 'array', items: {} }] })
  @Allow()
  value: unknown;
}

export class TemplateDto {
  @IsOptional() @IsString() @MaxLength(100) pushTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(300) pushBody?: string | null;
  @IsOptional() @IsString() @MaxLength(320) smsBody?: string | null;
  @IsOptional() @IsBoolean() critical?: boolean;
}

export class ConfirmPaymentDto {
  /** Receipt / transaction id seen in the merchant account. */
  @IsString()
  @Length(1, 100)
  receiptRef: string;
}

export class CompleteRefundDto {
  @IsString()
  @Length(1, 100)
  externalRef: string;
}

export class IssueRefundDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  amountToea?: number;

  @IsString()
  @Length(1, 300)
  reason: string;
}

export class AdjustmentDto {
  /** Signed toea: positive credits the wallet, negative debits it. */
  @IsInt()
  amountToea: number;

  @IsString()
  @Length(3, 300)
  reason: string;
}

export class PayoutActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ResolveDisputeDto {
  @IsIn(['reject', 'favour_driver', 'favour_customer'])
  decision: 'reject' | 'favour_driver' | 'favour_customer';

  @IsString()
  @Length(1, 2000)
  notes: string;

  /** favour_customer only; defaults to the full order price. */
  @IsOptional()
  @IsInt()
  @Min(0)
  refundToea?: number;
}

export class RoleDto {
  @IsString()
  @Length(1, 60)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsArray()
  @IsString({ each: true })
  permissions: string[];
}

export class CreateAdminDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(1, 80)
  name: string;

  @IsString()
  @Length(12, 200)
  password: string;

  @IsUUID()
  roleId: string;
}

export class UpdateAdminDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
  @IsOptional() @IsString() @Length(12, 200) password?: string;
  @IsOptional() @IsBoolean() resetTotp?: boolean;
}

export class AuditQuery extends CursorQuery {
  @IsOptional() @IsString() entity?: string;
  @IsOptional() @IsString() entityId?: string;
  @IsOptional() @IsUUID() actorId?: string;
  @IsOptional() @IsString() action?: string;
}

export class RangeQuery {
  /** ISO date (local day start) — defaults to 30 days ago. */
  @IsOptional() @IsString() from?: string;
  /** ISO date, exclusive — defaults to now. */
  @IsOptional() @IsString() to?: string;
}


export class PromoDto {
  @ApiProperty({ example: 'WATER10' })
  @IsString()
  @Length(3, 30)
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsIn(['percent', 'flat'])
  discountType: 'percent' | 'flat';

  /** percent: 1–100; flat: toea */
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  discountValue: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDiscountToea?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  minOrderToea?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  startsAt?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  expiresAt?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perCustomerLimit?: number;

  @IsOptional()
  @IsBoolean()
  public?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePromoDto {
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsIn(['percent', 'flat']) discountType?: 'percent' | 'flat';
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000) discountValue?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) maxDiscountToea?: number | null;
  @IsOptional() @IsInt() @Min(0) minOrderToea?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() startsAt?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() expiresAt?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) maxUses?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100) perCustomerLimit?: number;
  @IsOptional() @IsBoolean() public?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class BroadcastDto {
  /** drivers | customers | all | user (one person, by phone) */
  @ApiProperty({ enum: ['drivers', 'customers', 'all', 'user'] })
  @IsIn(['drivers', 'customers', 'all', 'user'])
  audience: 'drivers' | 'customers' | 'all' | 'user';

  /** Driver's or customer's phone, when audience = user. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiProperty()
  @IsString()
  @Length(1, 65)
  title: string;

  @ApiProperty()
  @IsString()
  @Length(1, 500)
  body: string;
}

export class BroadcastCountQuery {
  @ApiProperty({ enum: ['drivers', 'customers', 'all', 'user'] })
  @IsIn(['drivers', 'customers', 'all', 'user'])
  audience: 'drivers' | 'customers' | 'all' | 'user';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
