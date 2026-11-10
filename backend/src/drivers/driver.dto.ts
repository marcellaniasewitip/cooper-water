import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CursorQuery } from '../common/pagination';

export class UploadRequestDto {
  @IsIn(['document', 'topup_proof', 'proof_of_delivery', 'truck_photo'])
  purpose: 'document' | 'topup_proof' | 'proof_of_delivery' | 'truck_photo';

  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  contentType: string;

  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024)
  contentLength: number;
}

export class SubmitDocumentDto {
  @IsString()
  @Length(1, 50)
  type: string;

  @IsString()
  @MaxLength(300)
  fileKey: string;
}

export class TruckDto {
  @IsString()
  @Length(2, 20)
  plate: string;

  @IsInt()
  @Min(100)
  @Max(100000)
  capacityLitres: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  photoKey?: string;
}

export class LocationPointDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  /** ISO time the fix was taken (for batched uploads). */
  @IsOptional()
  @IsString()
  at?: string;
}

export class LocationBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LocationPointDto)
  points: LocationPointDto[];
}

export class TopupDto {
  @IsIn(['bank_transfer', 'cellmoney', 'cash'])
  method: 'bank_transfer' | 'cellmoney' | 'cash';

  @IsInt()
  @Min(100)
  @Max(10_000_000)
  amountToea: number;

  /** Bank transfer: the bank's transaction reference. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  proofFileKey?: string;

  /** Cell money: number to charge. */
  @IsOptional()
  @IsString()
  @Length(7, 20)
  msisdn?: string;
}

export class WithdrawalDto {
  @IsInt()
  @Min(100)
  amountToea: number;

  @IsIn(['cellmoney', 'bank_transfer'])
  method: 'cellmoney' | 'bank_transfer';

  /** Cell money number or bank account details. */
  @IsString()
  @Length(5, 200)
  destination: string;
}

export class EarningsQuery {
  @IsOptional()
  @IsIn(['today', 'week', 'month'])
  period?: 'today' | 'week' | 'month';
}

export class OptionalPositionDto {
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;
}

export class DriverListQuery extends CursorQuery {}
