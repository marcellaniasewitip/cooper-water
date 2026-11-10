import { IsIn, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @Length(1, 80)
  name: string;
}

export class PushTokenDto {
  /** FCM registration token; null/empty to unregister. */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  token?: string | null;
}

export class LocationDto {
  @IsString()
  @Length(1, 50)
  label: string;

  @IsString()
  @Length(1, 300)
  addressText: string;

  @IsLatitude()
  lat: number;

  @IsLongitude()
  lng: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  landmarkNotes?: string;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  label?: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  addressText?: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  landmarkNotes?: string;
}

export class CustomerTopupDto {
  /** How the money was paid: cash at a Cooper Waters office/depot, bank transfer, or cell money. */
  @IsIn(['cash', 'bank_transfer', 'cellmoney'])
  method: 'cash' | 'bank_transfer' | 'cellmoney';

  @IsInt()
  @Min(100)
  @Max(10_000_000)
  amountToea: number;

  /** Receipt number, bank reference or cell money transaction ID. */
  @IsString()
  @Length(1, 100)
  referenceText: string;

  /** Cell money: the number the money was sent from. */
  @IsOptional()
  @IsString()
  @Length(7, 20)
  msisdn?: string;
}

export class PromoCheckDto {
  @IsString()
  @Length(3, 30)
  code: string;
}

export class ReferralApplyDto {
  @IsString()
  @Length(4, 20)
  code: string;
}

export class ChatSendDto {
  @IsString()
  @Length(1, 1000)
  body: string;
}
