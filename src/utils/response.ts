
import type { Response } from "express";

interface ApiResponseOptions<T> {
  success?: boolean;
  message: string;
  data?: T;
}

export function sendResponse<T>(
  res: Response,
  statusCode: number,
  options: ApiResponseOptions<T>
) {
  return res.status(statusCode).json({
    success: options.success ?? true,
    message: options.message,
    ...(options.data !== undefined && { data: options.data }),
  });
}

export function sendError(
  res: Response,
  statusCode: number,
  message: string
) {
  return res.status(statusCode).json({
    success: false,
    message,
  });
}
