
import type { NextFunction, Request, Response } from "express";

type UserRole = "student" | "tutor" | "admin";

export function authorizeRoles(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as Request & {
      user?: { role?: string };
    }).user;

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!user.role || !allowedRoles.includes(user.role as UserRole)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this resource",
      });
    }

    next();
  };
}

export const verifyAdmin = authorizeRoles("admin");
export const verifyTutor = authorizeRoles("tutor");
export const verifyStudent = authorizeRoles("student");
