import { Global, Injectable, Module } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { loadEnv } from '../config/env';
import { Errors } from '../common/errors';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * S3-compatible storage for driver documents, top-up proofs and proof-of-delivery photos.
 * Clients upload directly with a short-lived presigned PUT; reads use presigned GETs (§12: signed URLs only).
 */
@Injectable()
export class StorageService {
  private readonly env = loadEnv();
  private readonly s3 = new S3Client({
    region: this.env.s3Region,
    endpoint: this.env.s3Endpoint,
    forcePathStyle: this.env.s3ForcePathStyle,
    // Phones PUT straight to the presigned URL. With the SDK default (WHEN_SUPPORTED) the URL carries the
    // CRC32 of an empty body, so real S3 rejects every upload with BadDigest. Only add checksums when required.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  async presignUpload(folder: string, ownerId: string, contentType: string, contentLength: number) {
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) throw Errors.invalid('unsupported_file_type', 'Upload a JPEG, PNG, WebP or PDF file');
    if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > MAX_BYTES)
      throw Errors.invalid('file_too_large', 'Files must be 10 MB or smaller');
    const key = `${folder}/${ownerId}/${randomUUID()}.${ext}`;
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.env.s3Bucket, Key: key, ContentType: contentType, ContentLength: contentLength }),
      { expiresIn: 600 },
    );
    return { key, url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresIn: 600 };
  }

  async presignDownload(key: string, expiresIn = 300): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.env.s3Bucket, Key: key }), { expiresIn });
  }

  /** Keys uploaded by an owner always live under `<folder>/<ownerId>/` — reject anything else. */
  assertOwnedKey(key: string, folder: string, ownerId: string): void {
    if (!key.startsWith(`${folder}/${ownerId}/`) || key.includes('..')) {
      throw Errors.invalid('invalid_file_key', 'Upload the file first and use the key returned');
    }
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
