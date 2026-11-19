
import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/ApiError.js";

export function errorMiddleware(
  error: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const statusCode =
    error instanceof ApiError ? error.statusCode : 500;

  const message =
    error instanceof ApiError
      ? error.message
      : "Internal server error";

  if (statusCode === 500) {
    console.error("Server Error:", error);
  }

  return res.status(statusCode).json({
    success: false,
    message,
  });
}
