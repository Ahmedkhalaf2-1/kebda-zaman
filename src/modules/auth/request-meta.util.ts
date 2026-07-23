import { Request } from 'express';
import { RequestMeta } from './token.service';

/** Pulls session-tracking metadata (plan §2.2: RefreshToken.userAgent/ip) off the request. */
export function extractRequestMeta(req: Request): RequestMeta {
  return {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  };
}
