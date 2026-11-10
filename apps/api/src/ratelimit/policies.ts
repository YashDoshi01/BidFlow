import type { Policy } from './limiter.ts';

/**
 * The limits, with the reasoning for each number. They are generous for a person and cheap to
 * exceed for a script; they protect PostgreSQL (every bid is a transaction on one auction row)
 * and the password hashing CPU, not revenue.
 *
 *  bid.user       a person does not place 20 bids in 10 s; a script does.
 *  bid.auction    all bidders together: 300 attempts in 10 s is 30/s on ONE row. The row lock
 *                 already serialises them, so beyond this the queue only grows (backpressure).
 *  login.ip       a shared office can log in many people; a guesser from one address cannot try
 *                 thousands of passwords.
 *  login.email    the account being attacked, from any number of addresses (a botnet): 10 tries
 *                 per 15 minutes per email. Side effect: someone can lock a victim's logins for
 *                 15 minutes by guessing wrongly on purpose (a known trade-off, docs/SECURITY.md).
 *  register.ip    account creation is expensive (password hashing) and a spam vector.
 *  read.ip        a general ceiling for everything else.
 *
 * Fallback limits (Redis down): a quarter of the limit per process, so up to four instances
 * together still stay near the real limit. Reads are allowed through.
 */
export interface RateLimitConfig {
  enabled: boolean;
  bidUserMax: number;
  bidAuctionMax: number;
  loginIpMax: number;
  loginEmailMax: number;
  registerIpMax: number;
  readIpMax: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  enabled: true,
  bidUserMax: 20,
  bidAuctionMax: 300,
  loginIpMax: 30,
  loginEmailMax: 10,
  registerIpMax: 10,
  readIpMax: 600,
};

const quarter = (n: number): number => Math.max(1, Math.ceil(n / 4));

export interface Policies {
  bidUser: Policy;
  bidAuction: Policy;
  loginIp: Policy;
  loginEmail: Policy;
  registerIp: Policy;
  readIp: Policy;
}

export function buildPolicies(c: RateLimitConfig): Policies {
  const fallback = (name: string, limit: number, windowMs: number): Policy => ({
    name,
    limit,
    windowMs,
    onRedisFailure: 'fallback',
    fallbackLimit: quarter(limit),
  });
  return {
    bidUser: fallback('bid_user', c.bidUserMax, 10_000),
    bidAuction: fallback('bid_auction', c.bidAuctionMax, 10_000),
    loginIp: fallback('login_ip', c.loginIpMax, 10 * 60_000),
    loginEmail: fallback('login_email', c.loginEmailMax, 15 * 60_000),
    registerIp: fallback('register_ip', c.registerIpMax, 60 * 60_000),
    readIp: {
      name: 'read_ip',
      limit: c.readIpMax,
      windowMs: 60_000,
      onRedisFailure: 'allow',
      fallbackLimit: c.readIpMax,
    },
  };
}
