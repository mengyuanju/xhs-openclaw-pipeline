declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    ADMIN_USERNAME?: string;
    ADMIN_PASSWORD_HASH?: string;
  }
}
