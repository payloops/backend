import * as jose from 'jose';
import { env } from './env';

const secret = new TextEncoder().encode(env.JWT_SECRET);

export interface JWTPayload {
  sub: string; // merchant id
  email: string;
}

export async function signJWT(payload: JWTPayload): Promise<string> {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

export async function verifyJWT(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secret);
    return payload as unknown as JWTPayload;
  } catch {
    return null;
  }
}
