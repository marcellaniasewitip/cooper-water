import { StorageService } from '../../src/storage/storage.service';

describe('StorageService.presignUpload', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    delete process.env.S3_ENDPOINT;
  });
  afterAll(() => {
    process.env = saved;
  });

  it('returns a URL real S3 accepts from a phone: no precomputed body checksum', async () => {
    const t = await new StorageService().presignUpload('document', 'driver-1', 'image/jpeg', 1234);
    const q = new URL(t.url).searchParams;
    // The SDK default bakes in the CRC32 of an empty body, so S3 answered every upload with BadDigest.
    expect(q.get('x-amz-checksum-crc32')).toBeNull();
    expect(q.get('x-amz-sdk-checksum-algorithm')).toBeNull();
    expect(t.key).toMatch(/^document\/driver-1\/.+\.jpg$/);
    expect(t).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
  });
});
