
import type { RequestHandler } from "express";
import {
  createRemoteJWKSet,
  jwtVerify,
} from "jose";

interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  plan: string;
}

const getBaseURL = () =>
  process.env.BETTER_AUTH_URL || "http://localhost:5000";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksURL = "";

const getJWKS = () => {
  const url = `${getBaseURL()}/api/auth/jwks`;

  if (!jwks || jwksURL !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksURL = url;
  }

  return jwks;
};

export const verifyToken: RequestHandler = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        message: "JWT token is required.",
      });
      return;
    }

    const token = authHeader.slice(7).trim();

    if (!token) {
      res.status(401).json({
        success: false,
        message: "JWT token is missing.",
      });
      return;
    }

    const baseURL = getBaseURL();

    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: baseURL,
      audience: baseURL,
    });

    const user: AuthUser = {
  id: String(payload.id || payload.sub || ""),
  name: String(payload.name || ""),
  email: String(payload.email || ""),
  role: String(payload.role || ""),
  plan: String(payload.plan || "free"),
};

    if (!user.id || !user.email || !user.role) {
      res.status(401).json({
        success: false,
        message: "Invalid JWT payload.",
      });
      return;
    }

    res.locals.user = user;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Invalid or expired JWT token.",
    });
  }
};

export const verifyStudent: RequestHandler = (req, res, next) => {
  const user = res.locals.user as AuthUser | undefined;

  if (user?.role !== "student") {
    res.status(403).json({
      success: false,
      message: "Access denied! Students only.",
    });
    return;
  }

  next();
};

export const verifyTutor: RequestHandler = (req, res, next) => {
  const user = res.locals.user as AuthUser | undefined;

  if (user?.role !== "tutor") {
    res.status(403).json({
      success: false,
      message: "Access denied! Tutors only.",
    });
    return;
  }

  next();
};

export const verifyAdmin: RequestHandler = (req, res, next) => {
  const user = res.locals.user as AuthUser | undefined;

  if (user?.role !== "admin") {
    res.status(403).json({
      success: false,
      message: "Access denied! Admins only.",
    });
    return;
  }

  next();
};
