import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class RequestOtpDto {
  /** Phone number; PNG numbers may omit +675. */
  @IsString()
  @Length(7, 20)
  phone: string;
}

export class VerifyOtpDto {
  @IsString()
  @Length(7, 20)
  phone: string;

  @IsString()
  @Length(6, 6)
  code: string;

  /** Which app is signing in; decides the role on first registration. */
  @IsIn(['customer', 'driver'])
  app: 'customer' | 'driver';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}

export class RefreshDto {
  @IsString()
  @MaxLength(200)
  refreshToken: string;
}

export class AdminLoginDto {
  @IsString()
  @MaxLength(200)
  email: string;

  @IsString()
  @Length(1, 200)
  password: string;
}

export class AdminTotpVerifyDto {
  @IsString()
  mfaToken: string;

  @IsString()
  @Length(6, 6)
  code: string;
}

export class TotpCodeDto {
  @IsString()
  @Length(6, 6)
  code: string;
}
