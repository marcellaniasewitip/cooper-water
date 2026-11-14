import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString, Length } from 'class-validator';
import { Roles } from '../auth/decorators';
import { MapsService } from './maps.service';

export class GeoSearchQuery {
  @IsString()
  @Length(2, 120)
  q: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;
}

export class GeoReverseQuery {
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsLongitude()
  lng: number;
}

/** Google Maps address search for the apps (the key stays on the server). */
@ApiTags('geo')
@ApiBearerAuth()
@Roles('customer', 'driver')
@Controller('geo')
export class MapsController {
  constructor(private readonly geo: MapsService) {}

  /** Whether address search is set up (apps hide the search box when it isn't). */
  @Get('status')
  status() {
    return { search: this.geo.enabled, provider: this.geo.enabled ? 'google' : null };
  }

  @Get('search')
  async search(@Query() q: GeoSearchQuery) {
    const near = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : undefined;
    return { items: await this.geo.search(q.q, near) };
  }

  @Get('reverse')
  async reverse(@Query() q: GeoReverseQuery) {
    return { place: await this.geo.reverse(q.lat, q.lng) };
  }
}
