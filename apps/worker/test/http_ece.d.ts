// http_ece (the RFC 8188 implementation web-push uses) ships no types; the
// tests only decrypt with it to check what a browser would receive.
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';
  const ece: {
    decrypt(
      buffer: Buffer,
      params: { version: 'aes128gcm'; privateKey: ECDH; authSecret: string },
    ): Buffer;
  };
  export default ece;
}
